import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import { sql } from '@aegis/db';
import { AppError, type ApiErrorBody, type ErrorCode } from '@aegis/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context';
import { rowsOf } from './core/http';
import { apiKeyRoutes } from './modules/apikeys';
import { auditRoutes } from './modules/audit';
import { authRoutes } from './modules/auth';
import { bucketRoutes } from './modules/buckets';
import { dashboardRoutes } from './modules/dashboard';
import { internalRoutes, nodeRoutes } from './modules/nodes';
import { objectRoutes } from './modules/objects';
import { registerAuth } from './plugins/auth';

function statusToCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  return status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL';
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.log.level ? { level: ctx.cfg.LOG_LEVEL } : false,
    trustProxy: true,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined)?.slice(0, 100) ?? randomUUID(),
  });

  await app.register(cookie);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    let status = 500;
    let code: ErrorCode = 'INTERNAL';
    let message = 'Internal server error';
    let details: unknown;

    if (err instanceof AppError) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if (err.statusCode && err.statusCode < 500) {
      status = err.statusCode;
      code = statusToCode(status);
      message = err.message;
    } else {
      req.log.error({ err }, 'unhandled error');
    }
    const body: ApiErrorBody = { error: { code, message, requestId: req.id, ...(details !== undefined && { details }) } };
    return reply.code(status).send(body);
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found`, requestId: req.id } }),
  );

  registerAuth(app, ctx);

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await ctx.db.execute(sql`SELECT 1`);
      const [n] = rowsOf<{ healthy: number }>(
        await ctx.db.execute(sql`SELECT count(*)::int AS healthy FROM storage_nodes WHERE status = 'HEALTHY'`),
      );
      const ready = (n?.healthy ?? 0) >= ctx.cfg.REPLICATION_FACTOR;
      return reply.code(ready ? 200 : 503).send({ ready, healthyNodes: n?.healthy ?? 0, required: ctx.cfg.REPLICATION_FACTOR });
    } catch (err) {
      return reply.code(503).send({ ready: false, error: String(err) });
    }
  });

  authRoutes(app, ctx);
  apiKeyRoutes(app, ctx);
  bucketRoutes(app, ctx);
  objectRoutes(app, ctx);
  nodeRoutes(app, ctx);
  dashboardRoutes(app, ctx);
  auditRoutes(app, ctx);
  internalRoutes(app, ctx);
  return app;
}
