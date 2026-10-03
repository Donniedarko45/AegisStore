import { sql } from '@aegis/db';
import { AppError, validateObjectKey } from '@aegis/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { requireBucket } from '../core/access';
import { audit } from '../core/audit';
import { iso, parse, rowsOf } from '../core/http';
import { RANGES, rangeOf } from '../core/visibility';
import { requireSiteAdmin, requireUser } from '../plugins/auth';

const listSchema = z.object({
  status: z.enum(['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED']).optional(),
  type: z.enum(['REPAIR_REPLICA', 'TRIM_REPLICA', 'VERIFY_REPLICA']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Self-healing visibility: what the reconciler sees, what the job runner is doing and has done.
 * Cluster-level (like node health), so any signed-in user may read it.
 */
export function healingRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/healing', async (req) => {
    requireUser(req);
    const [status] = rowsOf<{ value: Record<string, unknown>; updated_at: Date }>(
      await ctx.db.execute(sql`SELECT value, updated_at FROM settings WHERE key = 'reconciler.status'`),
    );
    const counts = rowsOf<{ type: string; status: string; n: number; bytes: number }>(
      await ctx.db.execute(sql`
        SELECT type, status, count(*)::int AS n, coalesce(sum(bytes), 0)::bigint AS bytes FROM jobs
         WHERE status IN ('QUEUED', 'RUNNING') OR created_at > now() - interval '24 hours'
         GROUP BY 1, 2`),
    );
    const [scrub] = rowsOf<{ total: number; verified_7d: number; oldest: Date | null }>(
      await ctx.db.execute(sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE coalesce(r.last_verified_at, r.created_at) > now() - interval '7 days')::int AS verified_7d,
               min(coalesce(r.last_verified_at, r.created_at)) AS oldest
          FROM replicas r JOIN object_versions v ON v.id = r.version_id
         WHERE r.state = 'HEALTHY' AND v.state = 'ACTIVE'`),
    );
    const [integrity] = rowsOf<{ corrupt: number; missing: number }>(
      await ctx.db.execute(sql`
        SELECT count(*) FILTER (WHERE r.state = 'CORRUPT')::int AS corrupt, count(*) FILTER (WHERE r.state = 'MISSING')::int AS missing
          FROM replicas r JOIN object_versions v ON v.id = r.version_id WHERE v.state = 'ACTIVE'`),
    );
    const sum = (f: (c: (typeof counts)[number]) => boolean) => counts.filter(f).reduce((a, c) => a + c.n, 0);
    return {
      reconciler: status ? { ...status.value, updatedAt: iso(status.updated_at) } : null,
      queue: {
        queued: sum((c) => c.status === 'QUEUED'),
        running: sum((c) => c.status === 'RUNNING'),
        done24h: sum((c) => c.status === 'DONE'),
        failed24h: sum((c) => c.status === 'FAILED'),
        repaired24h: sum((c) => c.status === 'DONE' && c.type === 'REPAIR_REPLICA'),
        trimmed24h: sum((c) => c.status === 'DONE' && c.type === 'TRIM_REPLICA'),
        verified24h: sum((c) => c.status === 'DONE' && c.type === 'VERIFY_REPLICA'),
        bytesHealed24h: counts.filter((c) => c.status === 'DONE' && c.type === 'REPAIR_REPLICA').reduce((a, c) => a + Number(c.bytes), 0),
      },
      scrub: {
        replicas: scrub?.total ?? 0,
        verified7d: scrub?.verified_7d ?? 0,
        oldestVerification: iso(scrub?.oldest ?? null),
      },
      integrity: integrity ?? { corrupt: 0, missing: 0 },
    };
  });

  app.get('/api/healing/jobs', async (req) => {
    requireUser(req);
    const q = parse(listSchema, req.query);
    const items = rowsOf<{
      id: string; type: string; status: string; priority: number; reason: string | null; payload: Record<string, unknown>;
      result: Record<string, unknown> | null; attempts: number; last_error: string | null; bytes: number;
      created_at: Date; started_at: Date | null; finished_at: Date | null;
    }>(
      await ctx.db.execute(sql`
        SELECT id, type, status, priority, reason, payload, result, attempts, last_error, bytes, created_at, started_at, finished_at
          FROM jobs
         WHERE (${q.status ?? null}::text IS NULL OR status = ${q.status ?? ''})
           AND (${q.type ?? null}::text IS NULL OR type = ${q.type ?? ''})
         ORDER BY (status IN ('RUNNING', 'QUEUED')) DESC, created_at DESC
         LIMIT ${q.limit}`),
    );
    return {
      items: items.map((j) => ({
        id: j.id,
        type: j.type,
        status: j.status,
        priority: j.priority,
        reason: j.reason,
        bucket: (j.payload.bucket as string | undefined) ?? null,
        key: (j.payload.key as string | undefined) ?? null,
        node: ((j.payload.targetNode ?? j.payload.node) as string | undefined) ?? null,
        result: j.result,
        attempts: j.attempts,
        lastError: j.last_error,
        bytes: Number(j.bytes),
        createdAt: iso(j.created_at),
        startedAt: iso(j.started_at),
        finishedAt: iso(j.finished_at),
      })),
    };
  });

  // Replication activity over time (jobs finished per bin, bytes healed) for the analytics chart.
  app.get<{ Querystring: { range?: string } }>('/api/healing/activity', async (req) => {
    requireUser(req);
    const range = rangeOf(req.query.range ?? '24h');
    const { interval, step } = RANGES[range];
    const series = rowsOf<{ t: Date; repaired: number; trimmed: number; verified: number; failed: number; bytes: number }>(
      await ctx.db.execute(sql`
        WITH bins AS (
          SELECT generate_series(date_bin(${step}::interval, now() - ${interval}::interval, 'epoch'::timestamptz),
                                 date_bin(${step}::interval, now(), 'epoch'::timestamptz), ${step}::interval) AS t
        ), j AS (
          SELECT date_bin(${step}::interval, finished_at, 'epoch'::timestamptz) AS t, type, status, bytes
            FROM jobs WHERE finished_at >= now() - ${interval}::interval - ${step}::interval
        )
        SELECT b.t,
               count(j.type) FILTER (WHERE j.type = 'REPAIR_REPLICA' AND j.status = 'DONE')::int AS repaired,
               count(j.type) FILTER (WHERE j.type = 'TRIM_REPLICA' AND j.status = 'DONE')::int AS trimmed,
               count(j.type) FILTER (WHERE j.type = 'VERIFY_REPLICA' AND j.status = 'DONE')::int AS verified,
               count(j.type) FILTER (WHERE j.status = 'FAILED')::int AS failed,
               coalesce(sum(j.bytes) FILTER (WHERE j.type = 'REPAIR_REPLICA' AND j.status = 'DONE'), 0)::bigint AS bytes
          FROM bins b LEFT JOIN j ON j.t = b.t GROUP BY b.t ORDER BY b.t`),
    );
    return { range, step, series: series.map((r) => ({ ...r, t: iso(r.t), bytes: Number(r.bytes) })) };
  });

  // Re-hash every replica of an object right now (instead of waiting for the rolling scrub).
  app.post<{ Params: { bucket: string }; Querystring: { key?: string } }>('/api/buckets/:bucket/object/verify', async (req) => {
    requireSiteAdmin(req);
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'READ');
    let key: string;
    try {
      key = validateObjectKey(req.query.key);
    } catch (e) {
      throw AppError.validation((e as Error).message);
    }
    const reps = rowsOf<{ id: string; node: string }>(
      await ctx.db.execute(sql`
        SELECT r.id, n.name AS node FROM objects o
          JOIN object_versions v ON v.id = o.current_version_id
          JOIN replicas r ON r.version_id = v.id
          JOIN storage_nodes n ON n.id = r.node_id
         WHERE o.bucket_id = ${bucket.id} AND o.key = ${key}`),
    );
    if (!reps.length) throw AppError.notFound('Object not found');
    for (const r of reps) {
      await ctx.db.execute(sql`
        INSERT INTO jobs (type, dedupe_key, priority, payload, reason, max_attempts)
        VALUES ('VERIFY_REPLICA', ${`verify:${r.id}`}, 5, ${JSON.stringify({ replicaId: r.id, bucket: bucket.name, key, node: r.node })}::jsonb, 'requested by administrator', 3)
        ON CONFLICT (dedupe_key) WHERE status IN ('QUEUED', 'RUNNING') DO NOTHING`);
    }
    await audit(ctx, req, { action: 'object.verify_requested', resourceType: 'object', metadata: { bucket: bucket.name, key, replicas: reps.length } });
    return { ok: true, queued: reps.length };
  });
}
