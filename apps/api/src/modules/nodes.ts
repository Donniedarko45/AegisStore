import { desc, eq, nodeMetrics, replicas, sql, storageNodes } from '@aegis/db';
import { AppError, HeartbeatBodyGuard, type NodeDto } from '@aegis/shared';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { audit } from '../core/audit';
import { iso, parse, rowsOf } from '../core/http';
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
    const now = new Date();

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
        ...(status !== existing.status && { statusChangedAt: now }),
      })
      .where(eq(storageNodes.id, existing.id));

    if (status !== existing.status) {
      await audit(ctx, null, { action: 'node.online', resourceType: 'node', resourceId: existing.id, metadata: { name: hb.name, from: existing.status, to: status }, actor: { type: 'SYSTEM', label: hb.name } });
      void publishEvent(ctx.redis, 'node.status', { name: hb.name, status });
    }
    return { ok: true, status };
  });
}
