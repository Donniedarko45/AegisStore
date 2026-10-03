import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { apiKeys, buckets, eq, simulationRuns, sql, storageNodes, users } from '@aegis/db';
import type { ChaosState } from '@aegis/nodeclient';
import { AppError } from '@aegis/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { audit } from '../core/audit';
import { iso, parse, rowsOf, textArray } from '../core/http';
import { publishEvent } from '../core/redis';
import { requireSiteAdmin } from '../plugins/auth';
import { mintApiKey } from './apikeys';

const chaosSchema = z.object({
  offline: z.boolean().optional(),
  latencyMs: z.number().min(0).max(10_000).optional(),
  errorRate: z.number().min(0).max(1).optional(),
  diskFillPct: z.number().min(0).max(100).optional(),
});
const corruptSchema = z.object({ bucket: z.string().max(63).optional(), key: z.string().max(1024).optional(), node: z.string().max(100).optional() });
const trafficSchema = z.object({
  objects: z.number().int().min(1).max(200).default(12),
  reads: z.number().int().min(0).max(5000).default(300),
  hotKeys: z.number().int().min(0).max(20).default(2),
  sizeKb: z.number().int().min(1).max(4096).default(64),
});
const ransomSchema = z.object({ files: z.number().int().min(5).max(200).default(30), autoLock: z.boolean().default(true) });

const ATTACKER_EMAIL = 'simulated-attacker@aegis.local';
const CALM: ChaosState = { offline: false, latencyMs: 0, errorRate: 0, diskFillPct: 0 };

/** What counts as a milestone on a run's timeline (injected -> detected -> healed). */
const MILESTONES = [
  'simulation.%', 'node.%', 'replica.%', 'object.integrity_failure', 'object.replica_missing', 'object.class_changed',
  'security.%', 'bucket.lock', 'bucket.unlock',
];

/**
 * Simulation Lab (architecture §9.8), administrators only. Faults are injected through each
 * node's authenticated chaos endpoint (no Docker socket in the API). Traffic and attacks run
 * through the real public API (in-process requests with a real, short-lived API key), so every
 * defence - access stats, classification, anomaly detection - sees exactly what a client would do.
 * Each run records a scope; its timeline is the audit trail inside that scope.
 */
export function simulationRoutes(app: FastifyInstance, ctx: AppContext) {
  const ref = (n: typeof storageNodes.$inferSelect) => ({ id: n.id, name: n.name, baseUrl: n.baseUrl });

  async function startRun(kind: string, userId: string, params: Record<string, unknown>, scope: { nodes?: string[]; buckets?: string[] }, status = 'RUNNING') {
    const [run] = await ctx.db
      .insert(simulationRuns)
      .values({ kind, status, params, scope, createdBy: userId, ...(status !== 'RUNNING' && { finishedAt: new Date() }) })
      .returning();
    void publishEvent(ctx.redis, 'simulation.updated', { runId: run!.id, kind, status });
    return run!;
  }
  async function finishRun(id: string, status: 'DONE' | 'FAILED', summary: Record<string, unknown>) {
    await ctx.db.update(simulationRuns).set({ status, summary, finishedAt: new Date() }).where(eq(simulationRuns.id, id));
    void publishEvent(ctx.redis, 'simulation.updated', { runId: id, status });
  }

  /** Run a request through the full HTTP stack in-process, authenticated with an API key. */
  const call = (token: string, method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Buffer | object, contentType?: string) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(contentType && { 'content-type': contentType }) },
      ...(payload !== undefined && { payload: payload as never }),
    });

  app.get('/api/simulation', async (req) => {
    requireSiteAdmin(req);
    const nodes = await ctx.db.select().from(storageNodes).orderBy(storageNodes.name);
    const chaos = await Promise.all(nodes.map((n) => ctx.storage.getChaos(ref(n)).catch(() => null)));
    const runs = await ctx.db.select().from(simulationRuns).orderBy(sql`${simulationRuns.startedAt} DESC`).limit(25);
    return {
      nodes: nodes.map((n, i) => ({ id: n.id, name: n.name, status: n.status, riskScore: n.riskScore, reachable: chaos[i] !== null, chaos: chaos[i] })),
      runs: runs.map((r) => ({ ...r, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt) })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/simulation/nodes/:id/chaos', async (req) => {
    const p = requireSiteAdmin(req);
    const patch = parse(chaosSchema, req.body ?? {});
    const [n] = await ctx.db.select().from(storageNodes).where(eq(storageNodes.id, req.params.id));
    if (!n) throw AppError.notFound('Node not found');
    const state = await ctx.storage.setChaos(ref(n), patch).catch((e: Error) => {
      throw new AppError(502, 'STORAGE_UNAVAILABLE', `${n.name} did not accept the fault: ${e.message}`);
    });
    const calm = !state.offline && !state.latencyMs && !state.errorRate && !state.diskFillPct;
    // one open CHAOS run per node; calming the node closes it
    const [open] = rowsOf<{ id: string }>(
      await ctx.db.execute(sql`SELECT id FROM simulation_runs WHERE kind = 'CHAOS' AND status = 'RUNNING' AND scope->'nodes' ? ${n.name} LIMIT 1`),
    );
    let runId = open?.id;
    if (calm && open) await finishRun(open.id, 'DONE', { restored: true });
    if (!calm && !open) runId = (await startRun('CHAOS', p.user.id, { node: n.name, ...patch }, { nodes: [n.name] })).id;
    if (!calm && open) await ctx.db.update(simulationRuns).set({ params: { node: n.name, ...state } }).where(eq(simulationRuns.id, open.id));
    await audit(ctx, req, { action: calm ? 'simulation.restore' : 'simulation.chaos', resourceType: 'node', resourceId: n.id, metadata: { name: n.name, node: n.name, ...state } });
    return { node: n.name, chaos: state, runId };
  });

  app.post('/api/simulation/reset', async (req) => {
    requireSiteAdmin(req);
    const nodes = await ctx.db.select().from(storageNodes);
    await Promise.allSettled(nodes.map((n) => ctx.storage.setChaos(ref(n), CALM)));
    const open = rowsOf<{ id: string }>(await ctx.db.execute(sql`SELECT id FROM simulation_runs WHERE kind = 'CHAOS' AND status = 'RUNNING'`));
    for (const r of open) await finishRun(r.id, 'DONE', { restored: true });
    await audit(ctx, req, { action: 'simulation.restore', resourceType: 'system', metadata: { nodes: nodes.map((n) => n.name) } });
    return { ok: true };
  });

  // Flip bytes in one replica on disk, then ask the scrubber to look right away.
  app.post('/api/simulation/corrupt', async (req) => {
    const p = requireSiteAdmin(req);
    const body = parse(corruptSchema, req.body ?? {});
    const [target] = rowsOf<{ replica_id: string; blob_id: string; bucket: string; key: string; node_id: string }>(
      await ctx.db.execute(sql`
        SELECT r.id AS replica_id, v.blob_id, b.name AS bucket, o.key, r.node_id
          FROM objects o JOIN object_versions v ON v.id = o.current_version_id JOIN buckets b ON b.id = o.bucket_id
          JOIN replicas r ON r.version_id = v.id JOIN storage_nodes n ON n.id = r.node_id
         WHERE r.state = 'HEALTHY' AND n.status <> 'OFFLINE' AND b.deleted_at IS NULL AND v.size > 0
           AND (${body.bucket ?? null}::text IS NULL OR b.name = ${body.bucket ?? ''})
           AND (${body.key ?? null}::text IS NULL OR o.key = ${body.key ?? ''})
           AND (${body.node ?? null}::text IS NULL OR n.name = ${body.node ?? ''})
         ORDER BY random() LIMIT 1`),
    );
    if (!target) throw AppError.notFound('No healthy replica matches; upload something first');
    const [n] = await ctx.db.select().from(storageNodes).where(eq(storageNodes.id, target.node_id));
    await ctx.storage.corruptBlob(ref(n!), target.blob_id);
    const run = await startRun('CORRUPT', p.user.id, { bucket: target.bucket, key: target.key, node: n!.name }, { nodes: [n!.name], buckets: [target.bucket] }, 'DONE');
    await ctx.db.execute(sql`
      INSERT INTO jobs (type, dedupe_key, priority, payload, reason, max_attempts)
      VALUES ('VERIFY_REPLICA', ${`verify:${target.replica_id}`}, 5, ${JSON.stringify({ replicaId: target.replica_id, bucket: target.bucket, key: target.key, node: n!.name })}::jsonb, 'simulation: bit rot injected', 3)
      ON CONFLICT (dedupe_key) WHERE status IN ('QUEUED', 'RUNNING') DO NOTHING`);
    await audit(ctx, req, { action: 'simulation.corrupt', resourceType: 'replica', resourceId: target.replica_id, metadata: { bucket: target.bucket, key: target.key, node: n!.name, runId: run.id } });
    return { runId: run.id, bucket: target.bucket, key: target.key, node: n!.name };
  });

  // Uploads a set of objects and reads a few of them heavily (drives HOT promotion + a 3rd replica).
  app.post('/api/simulation/traffic', async (req, reply) => {
    const p = requireSiteAdmin(req);
    const body = parse(trafficSchema, req.body ?? {});
    const bucket = 'sim-traffic';
    const run = await startRun('TRAFFIC', p.user.id, body, { buckets: [bucket] });
    await audit(ctx, req, { action: 'simulation.traffic', resourceType: 'bucket', metadata: { bucket, runId: run.id, ...body } });
    void (async () => {
      const { row, token } = await mintApiKey(ctx, p.user.id, 'simulation: traffic generator', ['read', 'write'], new Date(Date.now() + 3_600_000));
      const summary = { uploads: 0, reads: 0, errors: 0, hotKeys: [] as string[] };
      try {
        await call(token, 'POST', '/api/buckets', { name: bucket }, 'application/json'); // 409 when it exists: fine
        const keys = Array.from({ length: body.objects }, (_, i) => `traffic/object-${String(i + 1).padStart(3, '0')}.bin`);
        for (const key of keys) {
          const r = await call(token, 'PUT', `/api/buckets/${bucket}/object?key=${encodeURIComponent(key)}`, randomBytes(body.sizeKb * 1024), 'application/octet-stream');
          if (r.statusCode === 201) summary.uploads++;
          else summary.errors++;
        }
        summary.hotKeys = keys.slice(0, body.hotKeys);
        // 70 % of reads go to the hot keys, the rest spread evenly
        const pick = () => (summary.hotKeys.length && Math.random() < 0.7 ? summary.hotKeys[Math.floor(Math.random() * summary.hotKeys.length)]! : keys[Math.floor(Math.random() * keys.length)]!);
        let left = body.reads;
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            while (left-- > 0) {
              const r = await call(token, 'GET', `/api/buckets/${bucket}/object?key=${encodeURIComponent(pick())}`);
              if (r.statusCode === 200) summary.reads++;
              else summary.errors++;
            }
          }),
        );
        await finishRun(run.id, 'DONE', summary);
      } catch (err) {
        await finishRun(run.id, 'FAILED', { ...summary, error: (err as Error).message });
      } finally {
        await ctx.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, row.id));
      }
    })();
    return reply.code(202).send({ runId: run.id, bucket });
  });

  // A compromised API key encrypts a bucket in place and drops ransom notes.
  app.post('/api/simulation/ransomware', async (req, reply) => {
    const p = requireSiteAdmin(req);
    const body = parse(ransomSchema, req.body ?? {});
    const bucket = `sim-ransomware-${Date.now().toString(36)}`;
    const run = await startRun('RANSOMWARE', p.user.id, body, { buckets: [bucket] });
    await audit(ctx, req, { action: 'simulation.ransomware', resourceType: 'bucket', metadata: { bucket, runId: run.id, ...body } });
    void (async () => {
      let [attacker] = await ctx.db.select().from(users).where(eq(users.email, ATTACKER_EMAIL));
      if (!attacker) {
        [attacker] = await ctx.db
          .insert(users)
          .values({ email: ATTACKER_EMAIL, name: 'Simulated attacker', passwordHash: await hash(randomUUID()), role: 'MEMBER' })
          .returning();
      }
      const { row, token } = await mintApiKey(ctx, attacker!.id, 'stolen laptop key (simulation)', ['read', 'write'], new Date(Date.now() + 3_600_000));
      const summary = { files: body.files, uploaded: 0, encrypted: 0, notes: 0, blocked: 0 };
      try {
        await call(token, 'POST', '/api/buckets', { name: bucket }, 'application/json');
        if (body.autoLock) await ctx.db.update(buckets).set({ autoLock: true }).where(eq(buckets.name, bucket));
        const keys = Array.from({ length: body.files }, (_, i) => `finance/invoice-${String(i + 1).padStart(3, '0')}.csv`);
        for (const [i, key] of keys.entries()) {
          const csv = `id,customer,amount\n${Array.from({ length: 80 }, (_, j) => `${i * 100 + j},Customer ${j},${(j * 13.7).toFixed(2)}`).join('\n')}\n`;
          const r = await call(token, 'PUT', `/api/buckets/${bucket}/object?key=${encodeURIComponent(key)}`, Buffer.from(csv), 'text/csv');
          if (r.statusCode === 201) summary.uploaded++;
        }
        await new Promise((r) => setTimeout(r, 3000)); // the data existed before the attack
        for (const [i, key] of keys.entries()) {
          const enc = await call(token, 'PUT', `/api/buckets/${bucket}/object?key=${encodeURIComponent(key)}`, randomBytes(4096), 'application/octet-stream');
          if (enc.statusCode === 201) summary.encrypted++;
          else if (enc.statusCode === 423) summary.blocked++;
          if (i % 2 === 0) {
            const note = await call(token, 'PUT', `/api/buckets/${bucket}/object?key=${encodeURIComponent(`${key}.locked`)}`, randomBytes(2048), 'application/octet-stream');
            if (note.statusCode === 201) summary.notes++;
          }
        }
        await finishRun(run.id, 'DONE', summary);
      } catch (err) {
        await finishRun(run.id, 'FAILED', { ...summary, error: (err as Error).message });
      } finally {
        await ctx.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, row.id));
      }
    })();
    return reply.code(202).send({ runId: run.id, bucket });
  });

  app.get<{ Params: { id: string } }>('/api/simulation/runs/:id', async (req) => {
    requireSiteAdmin(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.notFound('Run not found');
    const [run] = await ctx.db.select().from(simulationRuns).where(eq(simulationRuns.id, req.params.id));
    if (!run) throw AppError.notFound('Run not found');
    const nodes = run.scope.nodes ?? [];
    const bucketNames = run.scope.buckets ?? [];
    const inScope = sql`(
      (resource_type = 'node' AND metadata->>'name' = ANY(${textArray(nodes)}))
      OR metadata->>'node' = ANY(${textArray(nodes)}) OR metadata->>'to' = ANY(${textArray(nodes)}) OR metadata->>'from' = ANY(${textArray(nodes)})
      OR metadata->>'bucket' = ANY(${textArray(bucketNames)}))`;
    const until = run.finishedAt && run.kind === 'CHAOS' ? sql`${run.finishedAt}::timestamptz + interval '2 minutes'` : sql`now()`;
    const events = rowsOf<{ action: string; actor_label: string | null; metadata: Record<string, unknown>; created_at: Date }>(
      await ctx.db.execute(sql`
        SELECT action, actor_label, metadata, created_at FROM audit_logs
         WHERE created_at >= ${run.startedAt}::timestamptz - interval '2 seconds' AND created_at <= ${until}
           AND action LIKE ANY(${textArray(MILESTONES)}) AND ${inScope}
         ORDER BY seq LIMIT 300`),
    );
    const [counts] = rowsOf<{ uploads: number; downloads: number; deletes: number }>(
      await ctx.db.execute(sql`
        SELECT count(*) FILTER (WHERE action = 'object.upload')::int AS uploads,
               count(*) FILTER (WHERE action = 'object.download')::int AS downloads,
               count(*) FILTER (WHERE action = 'object.delete')::int AS deletes
          FROM audit_logs WHERE created_at >= ${run.startedAt} AND metadata->>'bucket' = ANY(${textArray(bucketNames)})`),
    );
    return {
      run: { ...run, startedAt: iso(run.startedAt), finishedAt: iso(run.finishedAt) },
      counts,
      timeline: events.map((e) => ({ action: e.action, actor: e.actor_label, metadata: e.metadata, at: iso(e.created_at) })),
    };
  });
}
