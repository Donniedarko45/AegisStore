import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
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
  usedBytes = 0;
  blobCount = 0;

  constructor(
    root: string,
    private readonly capacityBytes: number,
  ) {
    this.blobsDir = path.join(path.resolve(root), 'blobs');
    this.tmpDir = path.join(path.resolve(root), 'tmp');
  }

  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
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

  hasCapacityFor(bytes: number): boolean {
    return this.usedBytes + bytes <= this.capacityBytes;
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

  /** Remove abandoned staged files (e.g. client disconnected, node crashed mid-upload). */
  async cleanStaleTmp(): Promise<number> {
    let removed = 0;
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
