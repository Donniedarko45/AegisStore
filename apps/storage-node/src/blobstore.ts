import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const STALE_TMP_MS = 60 * 60 * 1000;

export class BlobError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface StagedBlob {
  stagedToken: string;
  size: number;
  sha256: string;
}

/**
 * Dumb blob storage on local disk.
 *
 *   <root>/blobs/<first-2-chars>/<blobId>    committed data
 *   <root>/tmp/<blobId>.<token>              in-flight writes
 *
 * Writes are staged to tmp/ and moved with an atomic rename() on commit, so readers never see
 * partial files and a crash only leaves garbage in tmp/.
 */
export class BlobStore {
  private readonly blobsDir: string;
  private readonly tmpDir: string;
  private readonly partsDir: string;
  usedBytes = 0;
  blobCount = 0;
  /** bytes held by multipart parts that are not composed yet */
  partsBytes = 0;
  /** simulated fill (Simulation Lab): the disk reports and behaves as at least this full */
  virtualFillPct = 0;

  constructor(
    root: string,
    private readonly capacityBytes: number,
  ) {
    this.blobsDir = path.join(path.resolve(root), 'blobs');
    this.tmpDir = path.join(path.resolve(root), 'tmp');
    this.partsDir = path.join(path.resolve(root), 'parts');
  }

  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    await mkdir(this.partsDir, { recursive: true });
    await this.cleanStaleTmp();
    await this.scan();
  }

  static assertBlobId(blobId: string): string {
    if (!UUID_RE.test(blobId)) throw new BlobError(400, 'Invalid blob id');
    return blobId.toLowerCase();
  }

  static assertToken(token: string): string {
    if (!TOKEN_RE.test(token)) throw new BlobError(400, 'Invalid staged token');
    return token;
  }

  /** Path of a committed blob. blobId is validated as a UUID, so it cannot escape the root. */
  blobPath(blobId: string): string {
    const id = BlobStore.assertBlobId(blobId);
    return path.join(this.blobsDir, id.slice(0, 2), id);
  }

  private tmpPath(blobId: string, token: string): string {
    return path.join(this.tmpDir, `${BlobStore.assertBlobId(blobId)}.${BlobStore.assertToken(token)}`);
  }

  /** Path relative to the data dir, e.g. `blobs/ab/<id>` (stored in the DB for display) */
  relativePath(blobId: string): string {
    const id = BlobStore.assertBlobId(blobId);
    return `blobs/${id.slice(0, 2)}/${id}`;
  }

  /** what the node reports as used: real data, or the simulated fill when that is higher */
  get reportedUsedBytes(): number {
    return Math.max(this.usedBytes + this.partsBytes, Math.round((this.virtualFillPct / 100) * this.capacityBytes));
  }

  hasCapacityFor(bytes: number): boolean {
    return this.reportedUsedBytes + bytes <= this.capacityBytes;
  }

  async stage(blobId: string, body: Readable): Promise<StagedBlob> {
    const token = randomBytes(18).toString('base64url');
    const file = this.tmpPath(blobId, token);
    const hash = createHash('sha256');
    let size = 0;
    const hasher = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });

    try {
      await pipeline(body, hasher, createWriteStream(file, { flags: 'wx' }));
      // durability: flush file contents to disk before we acknowledge the stage
      const fh = await open(file, 'r');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (err) {
      await unlink(file).catch(() => undefined);
      throw err;
    }
    return { stagedToken: token, size, sha256: hash.digest('hex') };
  }

  async commit(blobId: string, token: string): Promise<{ size: number; path: string }> {
    const src = this.tmpPath(blobId, token);
    const dst = this.blobPath(blobId);
    let existing: { size: number } | null = null;
    try {
      existing = await stat(dst);
    } catch {
      /* not committed yet */
    }

    let size: number;
    try {
      size = (await stat(src)).size;
    } catch {
      // idempotent retry: already committed and the staged file is gone
      if (existing) return { size: existing.size, path: this.relativePath(blobId) };
      throw new BlobError(404, 'Staged blob not found');
    }

    await mkdir(path.dirname(dst), { recursive: true });
    await rename(src, dst);
    await this.syncDir(path.dirname(dst));
    if (existing) {
      this.usedBytes += size - existing.size;
    } else {
      this.usedBytes += size;
      this.blobCount += 1;
    }
    return { size, path: this.relativePath(blobId) };
  }

  async abort(blobId: string, token: string): Promise<void> {
    await unlink(this.tmpPath(blobId, token)).catch(() => undefined);
  }

  async head(blobId: string): Promise<{ size: number } | null> {
    try {
      const s = await stat(this.blobPath(blobId));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  openRead(blobId: string): ReadStream {
    return createReadStream(this.blobPath(blobId));
  }

  /** Re-hash the committed bytes on disk (scrub). */
  async verify(blobId: string): Promise<{ ok: boolean; sha256: string; size: number }> {
    const file = this.blobPath(blobId);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    return { ok: true, sha256: hash.digest('hex'), size };
  }

  // ------------------------------------------------------------------------- multipart parts
  //   <root>/parts/<uploadId>/<partNo>   one file per part; composed into a normal blob on complete

  private partDir(uploadId: string): string {
    return path.join(this.partsDir, BlobStore.assertBlobId(uploadId));
  }

  static assertPartNo(n: string | number): number {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > 10_000) throw new BlobError(400, 'Invalid part number');
    return v;
  }

  /** Store one part (re-uploading a part number replaces it). Written to tmp and renamed. */
  async putPart(uploadId: string, partNo: number, body: Readable): Promise<{ size: number; sha256: string }> {
    const dir = this.partDir(uploadId);
    await mkdir(dir, { recursive: true });
    const n = BlobStore.assertPartNo(partNo);
    const staged = await this.stage(uploadId, body); // same hashing + fsync path as blobs
    const file = path.join(dir, String(n));
    const old = await stat(file).catch(() => null);
    await rename(this.tmpPath(uploadId, staged.stagedToken), file);
    this.partsBytes += staged.size - (old?.size ?? 0);
    return { size: staged.size, sha256: staged.sha256 };
  }

  async listParts(uploadId: string): Promise<number[]> {
    const names = await readdir(this.partDir(uploadId)).catch(() => [] as string[]);
    return names.map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  }

  /**
   * Concatenate parts (in the given order) into a committed blob, hashing as it goes. The blob only
   * appears (atomic rename) once every byte is on disk and fsynced; the parts are then removed.
   */
  async compose(uploadId: string, blobId: string, parts: number[]): Promise<{ size: number; sha256: string; path: string }> {
    const dir = this.partDir(uploadId);
    const have = new Set(await this.listParts(uploadId));
    const missing = parts.filter((p) => !have.has(p));
    if (missing.length) throw new BlobError(409, `missing parts: ${missing.join(',')}`);

    const token = randomBytes(18).toString('base64url');
    const tmp = this.tmpPath(blobId, token);
    const hash = createHash('sha256');
    let size = 0;
    const out = createWriteStream(tmp, { flags: 'wx' });
    try {
      for (const p of parts) {
        for await (const chunk of createReadStream(path.join(dir, String(p)))) {
          const buf = chunk as Buffer;
          hash.update(buf);
          size += buf.length;
          if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      const fh = await open(tmp, 'r');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (err) {
      out.destroy();
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    const committed = await this.commit(blobId, token);
    await this.deleteParts(uploadId);
    return { size: committed.size, sha256: hash.digest('hex'), path: committed.path };
  }

  async deleteParts(uploadId: string): Promise<void> {
    const dir = this.partDir(uploadId);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const f = path.join(dir, name);
      const s = await stat(f).catch(() => null);
      await unlink(f).catch(() => undefined);
      if (s) this.partsBytes = Math.max(0, this.partsBytes - s.size);
    }
    await rmdir(dir).catch(() => undefined);
  }

  async delete(blobId: string): Promise<boolean> {
    const file = this.blobPath(blobId);
    try {
      const { size } = await stat(file);
      await unlink(file);
      this.usedBytes = Math.max(0, this.usedBytes - size);
      this.blobCount = Math.max(0, this.blobCount - 1);
      return true;
    } catch {
      return false;
    }
  }

  private async syncDir(dir: string): Promise<void> {
    try {
      const fh = await open(dir, 'r');
      await fh.sync();
      await fh.close();
    } catch {
      /* some filesystems don't support fsync on directories */
    }
  }

  private async scan(): Promise<void> {
    let used = 0;
    let count = 0;
    for (const shard of await readdir(this.blobsDir)) {
      const dir = path.join(this.blobsDir, shard);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const s = await stat(path.join(dir, name)).catch(() => null);
        if (s?.isFile()) {
          used += s.size;
          count += 1;
        }
      }
    }
    this.usedBytes = used;
    this.blobCount = count;
  }

  /** Remove abandoned staged files and multipart uploads nobody completed within 48 h. */
  async cleanStaleTmp(): Promise<number> {
    let removed = 0;
    for (const id of await readdir(this.partsDir).catch(() => [] as string[])) {
      const s = await stat(path.join(this.partsDir, id)).catch(() => null);
      if (s && Date.now() - s.mtimeMs > 48 * STALE_TMP_MS) {
        await this.deleteParts(id).catch(() => undefined);
        removed++;
      }
    }
    for (const name of await readdir(this.tmpDir)) {
      const file = path.join(this.tmpDir, name);
      const s = await stat(file).catch(() => null);
      if (s && Date.now() - s.mtimeMs > STALE_TMP_MS) {
        await unlink(file).catch(() => undefined);
        removed++;
      }
    }
    return removed;
  }
}
