import { desc, eq, nodeMetrics, replicas, sql, storageNodes } from '@aegis/db';
import { AppError, HeartbeatBodyGuard, type NodeDto } from '@aegis/shared';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { audit } from '../core/audit';
import { iso, parse, rowsOf } from '../core/http';
import { RANGES, rangeOf } from '../core/visibility';
import { HashRing } from '@aegis/hashring';
import { ringFor } from '../core/placement';
import { publishEvent } from '../core/redis';
import { requireUser } from '../plugins/auth';

export async function listNodeDtos(ctx: AppContext): Promise<NodeDto[]> {
  const nodes = await ctx.db.select().from(storageNodes).orderBy(storageNodes.name);
  const shares = ringFor(nodes, ctx.cfg.VNODES_PER_NODE).shares();
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    baseUrl: n.baseUrl,
    status: n.status,
    riskScore: n.riskScore,
    capacityBytes: n.capacityBytes,
    usedBytes: n.usedBytes,
    blobCount: n.blobCount,
    lastHeartbeatAt: iso(n.lastHeartbeatAt),
    ringSharePct: Math.round((shares.get(n.id) ?? 0) * 1000) / 10,
    metrics: n.lastMetrics ?? null,
  }));
}

export function nodeRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/nodes', async (req) => {
    requireUser(req);
    return { items: await listNodeDtos(ctx) };
  });

  // Every virtual node on the consistent-hash ring (for the interactive ring figure).
  app.get('/api/nodes/ring', async (req) => {
    requireUser(req);
    const nodes = await ctx.db.select().from(storageNodes).orderBy(storageNodes.name);
    const ring = ringFor(nodes, ctx.cfg.VNODES_PER_NODE);
    const shares = ring.shares();
    return {
      vnodesPerNode: ctx.cfg.VNODES_PER_NODE,
      replicationFactor: ctx.cfg.REPLICATION_FACTOR,
      nodes: nodes.map((n) => ({ id: n.id, name: n.name, status: n.status, sharePct: Math.round((shares.get(n.id) ?? 0) * 1000) / 10 })),
      points: ring.points(),
    };
  });

  // Where an arbitrary key lands on the ring (the browser cannot rely on WebCrypto over plain HTTP).
  app.get<{ Querystring: { key?: string } }>('/api/nodes/ring/locate', async (req) => {
    requireUser(req);
    const key = String(req.query.key ?? '').slice(0, 2048);
    return { key, pos: HashRing.position(key) };
  });

  // Downsampled metric series for all nodes: one row per time bin, one column per node.
  app.get<{ Querystring: { range?: string } }>('/api/nodes/metrics', async (req) => {
    requireUser(req);
    const range = rangeOf(req.query.range ?? '1h');
    const { interval, step } = RANGES[range];
    const rows = rowsOf<{ t: Date; name: string; cpu: number; mem: number; disk: number; p50: number; p95: number; err: number; probe: number }>(
      await ctx.db.execute(sql`
        SELECT date_bin(${step}::interval, m.ts, 'epoch'::timestamptz) AS t, n.name,
               avg(m.cpu_pct)::real AS cpu, avg(m.mem_pct)::real AS mem, max(m.disk_used_pct)::real AS disk,
               avg(m.latency_ms_p50)::real AS p50, max(m.latency_ms_p95)::real AS p95, avg(m.error_rate)::real AS err,
               avg(m.probe_ms)::real AS probe
          FROM node_metrics m JOIN storage_nodes n ON n.id = m.node_id
         WHERE m.ts >= now() - ${interval}::interval
         GROUP BY 1, 2 ORDER BY 1`),
    );
    const names = [...new Set(rows.map((r) => r.name))].sort();
    const pivot = (k: 'cpu' | 'mem' | 'disk' | 'p50' | 'p95' | 'err' | 'probe') => {
      const byT = new Map<string, Record<string, number | string>>();
      for (const r of rows) {
        const t = iso(r.t)!;
        const row = byT.get(t) ?? { t };
        row[r.name] = Math.round(Number(r[k]) * 100) / 100;
        byT.set(t, row);
      }
      return [...byT.values()];
    };
    return { range, step, nodes: names, cpu: pivot('cpu'), mem: pivot('mem'), disk: pivot('disk'), latencyP50: pivot('p50'), latencyP95: pivot('p95'), errorRate: pivot('err'), probe: pivot('probe') };
  });

  // Status-page style availability, reconstructed from node.registered/offline/online audit events.
  app.get<{ Querystring: { range?: string } }>('/api/nodes/uptime', async (req) => {
    requireUser(req);
    const range = req.query.range === '7d' ? '7d' : req.query.range === '1h' ? '1h' : '24h';
    const spanMs = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 }[range];
    const barsN = { '1h': 60, '24h': 48, '7d': 84 }[range];
    const end = Date.now();
    const start = end - spanMs;
    const nodes = await ctx.db.select().from(storageNodes).orderBy(storageNodes.name);
    const events = rowsOf<{ node_id: string; action: string; at: Date | string }>(
      await ctx.db.execute(sql`
        SELECT resource_id AS node_id, action, created_at AS at FROM audit_logs
         WHERE resource_type = 'node' AND action IN ('node.registered', 'node.offline', 'node.online')
         ORDER BY seq`),
    );
    const barMs = spanMs / barsN;
    return {
      range,
      nodes: nodes.map((n) => {
        // build [from, to, up] intervals from this node's transition history
        const evs = events.filter((e) => e.node_id === n.id).map((e) => ({ at: new Date(e.at).getTime(), up: e.action !== 'node.offline' }));
        const born = evs[0]?.at ?? n.registeredAt.getTime();
        const intervals: { from: number; to: number; up: boolean }[] = [];
        let state = true;
        let since = born;
        for (const e of evs) {
          if (e.up !== state) {
            intervals.push({ from: since, to: e.at, up: state });
            state = e.up;
            since = e.at;
          }
        }
        intervals.push({ from: since, to: end, up: state });

        const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
        const bars = Array.from({ length: barsN }, (_, i) => {
          const b0 = start + i * barMs;
          const b1 = b0 + barMs;
          const known = overlap(b0, b1, born, end);
          const up = intervals.filter((iv) => iv.up).reduce((a, iv) => a + overlap(b0, b1, iv.from, iv.to), 0);
          return { t: new Date(b0).toISOString(), upPct: known > 0 ? Math.round((up / known) * 1000) / 10 : null };
        });
        const knownTotal = overlap(start, end, born, end);
        const upTotal = intervals.filter((iv) => iv.up).reduce((a, iv) => a + overlap(start, end, iv.from, iv.to), 0);
        const incidents = intervals
          .filter((iv) => !iv.up && iv.to > start)
          .map((iv) => ({ start: new Date(iv.from).toISOString(), end: iv.to >= end && !state ? null : new Date(iv.to).toISOString(), durationSec: Math.round((iv.to - iv.from) / 1000) }))
          .reverse();
        return {
          id: n.id,
          name: n.name,
          status: n.status,
          uptimePct: knownTotal > 0 ? Math.round((upTotal / knownTotal) * 10000) / 100 : null,
          bars,
          incidents,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/nodes/:id', async (req) => {
    requireUser(req);
    const dto = (await listNodeDtos(ctx)).find((n) => n.id === req.params.id);
    if (!dto) throw AppError.notFound('Node not found');
    const history = await ctx.db
      .select()
      .from(nodeMetrics)
      .where(eq(nodeMetrics.nodeId, dto.id))
      .orderBy(desc(nodeMetrics.ts))
      .limit(120);
    const [counts] = rowsOf<{ replicas: number; objects: number }>(
      await ctx.db.execute(sql`
        SELECT count(*)::int AS replicas, count(DISTINCT version_id)::int AS objects
        FROM ${replicas} WHERE node_id = ${dto.id} AND state = 'HEALTHY'`),
    );
    return {
      node: dto,
      replicaCount: counts?.replicas ?? 0,
      history: history.reverse().map((h) => ({ ...h, ts: iso(h.ts) })),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Internal API used by storage nodes (not routed through nginx)
// ---------------------------------------------------------------------------------------------
function secretMatches(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function internalRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/internal/nodes/heartbeat', async (req) => {
    if (!secretMatches(req.headers.authorization, ctx.cfg.NODE_SHARED_SECRET)) {
      throw AppError.unauthenticated('Bad node credentials');
    }
    const hb = parse(HeartbeatBodyGuard, req.body);
    // database clock, never the API's: the sweeper compares against the DB's now()
    const now = sql`now()`;

    const [existing] = await ctx.db.select().from(storageNodes).where(eq(storageNodes.name, hb.name));
    if (!existing) {
      const [created] = await ctx.db
        .insert(storageNodes)
        .values({
          name: hb.name,
          baseUrl: hb.baseUrl,
          status: 'HEALTHY',
          capacityBytes: hb.metrics.diskCapacityBytes,
          usedBytes: hb.metrics.diskUsedBytes,
          blobCount: hb.metrics.blobCount,
          lastHeartbeatAt: now,
          lastMetrics: hb.metrics,
          vnodeCount: ctx.cfg.VNODES_PER_NODE,
        })
        .returning();
      await audit(ctx, null, { action: 'node.registered', resourceType: 'node', resourceId: created!.id, metadata: { name: hb.name, baseUrl: hb.baseUrl }, actor: { type: 'SYSTEM', label: hb.name } });
      void publishEvent(ctx.redis, 'node.status', { name: hb.name, status: 'HEALTHY' });
      return { ok: true, status: 'HEALTHY' };
    }

    // A node that was OFFLINE must send PROBATION_BEATS consecutive heartbeats before it is trusted again.
    let status = existing.status;
    let probation = 0;
    if (existing.status === 'OFFLINE') {
      probation = existing.probationBeats + 1;
      if (probation >= ctx.cfg.PROBATION_BEATS) {
        status = 'HEALTHY';
        probation = 0;
      }
    }
    await ctx.db
      .update(storageNodes)
      .set({
        baseUrl: hb.baseUrl,
        status,
        probationBeats: probation,
        capacityBytes: hb.metrics.diskCapacityBytes,
        usedBytes: hb.metrics.diskUsedBytes,
        blobCount: hb.metrics.blobCount,
        lastHeartbeatAt: now,
        lastMetrics: hb.metrics,
        ...(status !== existing.status && { statusChangedAt: sql`now()` }),
      })
      .where(eq(storageNodes.id, existing.id));

    void publishEvent(ctx.redis, 'node.metrics', { id: existing.id, name: hb.name, status, metrics: hb.metrics });
    if (status !== existing.status) {
      await audit(ctx, null, { action: 'node.online', resourceType: 'node', resourceId: existing.id, metadata: { name: hb.name, from: existing.status, to: status }, actor: { type: 'SYSTEM', label: hb.name } });
      void publishEvent(ctx.redis, 'node.status', { name: hb.name, status });
    }
    return { ok: true, status };
  });
}
