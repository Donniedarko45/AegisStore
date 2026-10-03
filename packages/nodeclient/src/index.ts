import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
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

const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 64 });

const CONTROL_TIMEOUT_MS = 10_000;

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
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!res.ok) throw new NodeHttpError(res.status, `${node.name}: ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /** Start a streamed PUT to `node`. The caller writes chunks and then calls `end()`. */
  startStage(node: NodeRef, blobId: string, opts: { requestId?: string; expectedSize?: number } = {}): StageSink {
    const url = new URL(`${node.baseUrl}/internal/blobs/${blobId}/stage`);
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

  deleteBlob(node: NodeRef, blobId: string) {
    return this.json(node, `/internal/blobs/${blobId}`, { method: 'DELETE' }).catch(() => undefined);
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
}
