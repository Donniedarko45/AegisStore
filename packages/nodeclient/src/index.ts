import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export interface NodeRef {
  id: string;
  name: string;
  baseUrl: string;
}

export interface StagedResult {
  stagedToken: string;
  size: number;
  sha256: string;
}

/** A single in-flight streamed PUT to one node. */
export interface StageSink {
  node: NodeRef;
  /** returns false when the caller should wait for `drained()` (backpressure) */
  write(chunk: Buffer): boolean;
  drained(): Promise<void>;
  end(): void;
  destroy(err?: Error): void;
  /** set as soon as the request fails */
  failed: Error | null;
  /** rejects when the request fails; used to race against backpressure waits */
  errored: Promise<never>;
  /** resolves with the node's answer once the body is fully staged */
  result: Promise<StagedResult>;
}

export class NodeHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Why a node-to-node copy failed, so callers can react (flag the source vs. retry elsewhere). */
export class CopyError extends Error {
  constructor(
    public readonly kind: 'SOURCE_UNAVAILABLE' | 'SOURCE_MISSING' | 'SOURCE_CORRUPT' | 'TARGET_FAILED' | 'TARGET_MISMATCH',
    message: string,
  ) {
    super(message);
  }
}

const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 64 });

const CONTROL_TIMEOUT_MS = 10_000;
/** composing a multi-GB object reads and writes every byte once */
const COMPOSE_TIMEOUT_MS = 10 * 60_000;

/** Typed client for the storage nodes' internal API. Knows nothing about buckets or users. */
export class StorageClient {
  constructor(private readonly secret: string) {}

  private headers(requestId?: string): Record<string, string> {
    return { authorization: `Bearer ${this.secret}`, ...(requestId ? { 'x-request-id': requestId } : {}) };
  }

  private async json<T>(node: NodeRef, path: string, init: RequestInit, requestId?: string): Promise<T> {
    const res = await fetch(`${node.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(requestId), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(path.endsWith('/compose') ? COMPOSE_TIMEOUT_MS : CONTROL_TIMEOUT_MS),
    });
    if (!res.ok) throw new NodeHttpError(res.status, `${node.name}: ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /** Start a streamed PUT to `node`. The caller writes chunks and then calls `end()`. */
  startStage(node: NodeRef, blobId: string, opts: { requestId?: string; expectedSize?: number } = {}): StageSink {
    return this.startPut(node, `/internal/blobs/${blobId}/stage`, opts);
  }

  /** Streamed PUT of one multipart part (same sink contract as a stage). */
  startPart(node: NodeRef, uploadId: string, partNo: number, opts: { requestId?: string; expectedSize?: number } = {}): StageSink {
    return this.startPut(node, `/internal/parts/${uploadId}/${partNo}`, opts);
  }

  /** Concatenate an upload's parts into a committed blob on the node. */
  compose(node: NodeRef, uploadId: string, blobId: string, parts: number[], requestId?: string) {
    return this.json<{ size: number; sha256: string; path: string }>(
      node,
      `/internal/parts/${uploadId}/compose`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobId, parts }) },
      requestId,
    );
  }

  /** Best effort: remove an upload's parts from the node. */
  abortParts(node: NodeRef, uploadId: string) {
    return this.json(node, `/internal/parts/${uploadId}`, { method: 'DELETE' }).catch(() => undefined);
  }

  private startPut(node: NodeRef, path: string, opts: { requestId?: string; expectedSize?: number }): StageSink {
    const url = new URL(`${node.baseUrl}${path}`);
    const secure = url.protocol === 'https:';
    const req = (secure ? httpsRequest : httpRequest)(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'PUT',
        agent: secure ? httpsAgent : httpAgent,
        headers: {
          ...this.headers(opts.requestId),
          'content-type': 'application/octet-stream',
          ...(opts.expectedSize !== undefined ? { 'x-expected-size': String(opts.expectedSize) } : {}),
        },
      },
    );

    const sink: StageSink = {
      node,
      failed: null,
      write: (chunk) => req.write(chunk),
      drained: () => new Promise<void>((resolve) => req.once('drain', () => resolve())),
      end: () => req.end(),
      destroy: (err) => req.destroy(err),
      errored: undefined as unknown as Promise<never>,
      result: undefined as unknown as Promise<StagedResult>,
    };

    sink.result = new Promise<StagedResult>((resolve, reject) => {
      req.on('response', (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          if (!res.statusCode || res.statusCode >= 300) {
            return reject(new NodeHttpError(res.statusCode ?? 502, `${node.name}: stage -> ${res.statusCode} ${text.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(text) as StagedResult);
          } catch {
            reject(new Error(`${node.name}: invalid stage response`));
          }
        });
      });
      req.on('error', (err) => reject(new Error(`${node.name}: ${err.message}`)));
      req.setTimeout(60_000, () => req.destroy(new Error('stage timeout')));
    });
    sink.errored = sink.result.then(
      () => new Promise<never>(() => undefined), // success never "errors"
      (err: Error) => {
        sink.failed = err;
        throw err;
      },
    );
    // avoid unhandled-rejection noise; callers still observe failures via `result`/`errored`
    sink.result.catch(() => undefined);
    sink.errored.catch(() => undefined);
    return sink;
  }

  commit(node: NodeRef, blobId: string, stagedToken: string, requestId?: string) {
    return this.json<{ ok: boolean; size: number; path: string }>(
      node,
      `/internal/blobs/${blobId}/commit`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stagedToken }) },
      requestId,
    );
  }

  abort(node: NodeRef, blobId: string, stagedToken: string) {
    return this.json(node, `/internal/blobs/${blobId}/stage/${stagedToken}`, { method: 'DELETE' }).catch(() => undefined);
  }

  /** Best effort: never throws (used for cleanup after failed writes). */
  deleteBlob(node: NodeRef, blobId: string) {
    return this.json(node, `/internal/blobs/${blobId}`, { method: 'DELETE' }).catch(() => undefined);
  }

  /** True only when the node confirmed the blob is gone (deleted now or already absent). */
  async tryDeleteBlob(node: NodeRef, blobId: string): Promise<boolean> {
    try {
      await this.json(node, `/internal/blobs/${blobId}`, { method: 'DELETE' });
      return true;
    } catch {
      return false;
    }
  }

  verify(node: NodeRef, blobId: string) {
    return this.json<{ ok: boolean; sha256: string; size: number }>(node, `/internal/blobs/${blobId}/verify`, { method: 'POST' });
  }

  /**
   * Open a blob for reading. `status` 404 means the node does not have it.
   * The connection timeout only covers getting response headers, not the body transfer.
   */
  async openBlob(
    node: NodeRef,
    blobId: string,
    requestId?: string,
  ): Promise<{ status: number; size: number; stream: Readable | null }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CONTROL_TIMEOUT_MS);
    try {
      const res = await fetch(`${node.baseUrl}/internal/blobs/${blobId}`, {
        headers: this.headers(requestId),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        return { status: res.status, size: 0, stream: null };
      }
      return {
        status: res.status,
        size: Number(res.headers.get('content-length') ?? 0),
        stream: Readable.fromWeb(res.body as never),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Copy one committed blob from `from` to `to` through this process (constant memory, honours
   * backpressure). The bytes are hashed in flight and must match `expectedSha256` both here and on
   * the target before the target commits, so a copy can never spread corruption.
   */
  async copyBlob(
    from: NodeRef,
    to: NodeRef,
    blobId: string,
    expected: { sha256: string; size: number },
    requestId?: string,
  ): Promise<{ size: number; path: string }> {
    let src;
    try {
      src = await this.openBlob(from, blobId, requestId);
    } catch (err) {
      throw new CopyError('SOURCE_UNAVAILABLE', `${from.name}: ${(err as Error).message}`);
    }
    if (src.status === 404) throw new CopyError('SOURCE_MISSING', `${from.name}: blob missing`);
    if (!src.stream) throw new CopyError('SOURCE_UNAVAILABLE', `${from.name}: HTTP ${src.status}`);

    const sink = this.startStage(to, blobId, { requestId, expectedSize: expected.size });
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of src.stream) {
        const buf = chunk as Buffer;
        hash.update(buf);
        size += buf.length;
        if (sink.failed) throw sink.failed;
        if (!sink.write(buf)) await Promise.race([sink.drained(), sink.errored]);
      }
      sink.end();
    } catch (err) {
      sink.destroy(err as Error);
      src.stream.destroy();
      throw new CopyError('TARGET_FAILED', `${to.name}: ${(err as Error).message}`);
    }
    let staged: StagedResult;
    try {
      staged = await sink.result;
    } catch (err) {
      throw new CopyError('TARGET_FAILED', (err as Error).message);
    }
    const actual = hash.digest('hex');
    if (actual !== expected.sha256 || size !== expected.size) {
      await this.abort(to, blobId, staged.stagedToken);
      throw new CopyError('SOURCE_CORRUPT', `${from.name}: source bytes do not match the recorded checksum`);
    }
    if (staged.sha256 !== expected.sha256 || staged.size !== expected.size) {
      await this.abort(to, blobId, staged.stagedToken);
      throw new CopyError('TARGET_MISMATCH', `${to.name}: staged checksum mismatch`);
    }
    try {
      const c = await this.commit(to, blobId, staged.stagedToken, requestId);
      return { size: c.size, path: c.path };
    } catch (err) {
      await this.abort(to, blobId, staged.stagedToken);
      throw new CopyError('TARGET_FAILED', (err as Error).message);
    }
  }
}
