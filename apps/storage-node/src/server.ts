import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { BlobError, BlobStore } from './blobstore';
import type { MetricsCollector } from './metrics';

export interface ServerDeps {
  store: BlobStore;
  metrics: MetricsCollector;
  secret: string;
  nodeName: string;
  logLevel?: string;
}

function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { store, metrics, secret, nodeName } = deps;
  const app = Fastify({
    logger: { level: deps.logLevel ?? 'info', base: { node: nodeName } },
    // payloads are streamed to disk, never buffered; the API enforces object-size limits
    bodyLimit: Number.MAX_SAFE_INTEGER,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
  });

  // Raw (stream) body for every content type: blobs are never parsed or buffered.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/internal/') && !bearerMatches(req.headers.authorization, secret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // Request latency feeds the risk score. Streaming a 50 MB blob takes long because it is big, not
  // because the node is slow, so only small transfers count as latency samples (all count as errors).
  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/internal/blobs')) return;
    const bytes = Number(req.headers['x-expected-size'] ?? req.headers['content-length'] ?? reply.getHeader('content-length') ?? 0);
    metrics.record(bytes <= 1024 * 1024 ? reply.elapsedTime : null, reply.statusCode >= 500);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof BlobError) return reply.code(err.status).send({ error: err.message });
    req.log.error({ err }, 'request failed');
    return reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: err.message });
  });

  // Unauthenticated liveness probe for container health checks
  app.get('/healthz', async () => ({ ok: true, node: nodeName }));

  app.get('/internal/health', async () => ({
    ok: true,
    node: nodeName,
    usedBytes: store.usedBytes,
    blobCount: store.blobCount,
  }));

  type BlobParams = { Params: { blobId: string } };

  app.put<BlobParams & { Body: NodeJS.ReadableStream }>('/internal/blobs/:blobId/stage', async (req, reply) => {
    const blobId = BlobStore.assertBlobId(req.params.blobId);
    const len = Number(req.headers['x-expected-size'] ?? req.headers['content-length']);
    if (Number.isFinite(len) && !store.hasCapacityFor(len)) {
      return reply.code(507).send({ error: 'insufficient storage' });
    }
    const body = req.body as unknown as import('node:stream').Readable;
    if (!body || typeof body.pipe !== 'function') {
      return reply.code(400).send({ error: 'expected a streamed request body' });
    }
    return store.stage(blobId, body);
  });

  app.post<BlobParams & { Body: { stagedToken?: string } }>('/internal/blobs/:blobId/commit', async (req) => {
    const token = (req.body as { stagedToken?: string } | undefined)?.stagedToken;
    if (!token) throw new BlobError(400, 'stagedToken required');
    const { size, path } = await store.commit(req.params.blobId, token);
    return { ok: true, size, path };
  });

  app.delete<{ Params: { blobId: string; token: string } }>('/internal/blobs/:blobId/stage/:token', async (req) => {
    await store.abort(req.params.blobId, req.params.token);
    return { ok: true };
  });

  app.get<BlobParams>('/internal/blobs/:blobId', { exposeHeadRoute: false }, async (req, reply) => {
    const info = await store.head(req.params.blobId);
    if (!info) return reply.code(404).send({ error: 'blob not found' });
    reply.header('content-length', info.size).header('content-type', 'application/octet-stream');
    return reply.send(store.openRead(req.params.blobId));
  });

  app.head<BlobParams>('/internal/blobs/:blobId', async (req, reply) => {
    const info = await store.head(req.params.blobId);
    if (!info) return reply.code(404).send();
    return reply.header('content-length', info.size).send();
  });

  app.post<BlobParams>('/internal/blobs/:blobId/verify', async (req, reply) => {
    const info = await store.head(req.params.blobId);
    if (!info) return reply.code(404).send({ error: 'blob not found' });
    return store.verify(req.params.blobId);
  });

  app.delete<BlobParams>('/internal/blobs/:blobId', async (req) => ({
    ok: true,
    deleted: await store.delete(req.params.blobId),
  }));

  return app;
}
