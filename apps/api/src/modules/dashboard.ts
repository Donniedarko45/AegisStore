import { sql, storageNodes } from '@aegis/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { iso, rowsOf } from '../core/http';
import { requireUser } from '../plugins/auth';

export function dashboardRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/dashboard/summary', async (req) => {
    const { user } = requireUser(req);
    const isAdmin = user.role === 'ADMIN';

    const nodes = await ctx.db.select().from(storageNodes).orderBy(storageNodes.name);

    // objects/buckets are scoped to what the caller can see
    const [mine] = rowsOf<{ buckets: number; objects: number; bytes: number }>(
      await ctx.db.execute(sql`
        WITH visible AS (
          SELECT b.id FROM buckets b
          LEFT JOIN bucket_grants g ON g.bucket_id = b.id AND g.user_id = ${user.id}
          WHERE b.deleted_at IS NULL AND (${isAdmin} OR b.owner_id = ${user.id} OR g.id IS NOT NULL))
        SELECT (SELECT count(*) FROM visible)::int AS buckets,
               count(o.id)::int AS objects,
               coalesce(sum(v.size), 0)::bigint AS bytes
        FROM visible vb
        JOIN objects o ON o.bucket_id = vb.id
        JOIN object_versions v ON v.id = o.current_version_id AND v.state = 'ACTIVE'`),
    );
    const bucketCount = mine?.buckets ?? 0;

    const activity = rowsOf<{
      id: string; action: string; actor_label: string | null; resource_type: string | null;
      metadata: Record<string, unknown>; created_at: Date;
    }>(
      await ctx.db.execute(sql`
        SELECT id, action, actor_label, resource_type, metadata, created_at
        FROM audit_logs
        WHERE ${isAdmin} OR actor_id = ${user.id}
        ORDER BY seq DESC LIMIT 10`),
    );

    const capacity = nodes.reduce((a, n) => a + n.capacityBytes, 0);
    const used = nodes.reduce((a, n) => a + n.usedBytes, 0);
    const byStatus = { HEALTHY: 0, WARNING: 0, HIGH_RISK: 0, OFFLINE: 0, DRAINING: 0 } as Record<string, number>;
    for (const n of nodes) byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;

    return {
      storage: { capacityBytes: capacity, usedBytes: used, usedPct: capacity ? Math.round((used / capacity) * 1000) / 10 : 0 },
      logical: { bucketCount, objectCount: mine?.objects ?? 0, bytes: Number(mine?.bytes ?? 0) },
      nodes: {
        total: nodes.length,
        healthy: byStatus.HEALTHY ?? 0,
        atRisk: nodes.length - (byStatus.HEALTHY ?? 0),
        byStatus,
      },
      perNode: nodes.map((n) => ({
        id: n.id,
        name: n.name,
        status: n.status,
        usedBytes: n.usedBytes,
        capacityBytes: n.capacityBytes,
        usedPct: n.capacityBytes ? Math.round((n.usedBytes / n.capacityBytes) * 1000) / 10 : 0,
        blobCount: n.blobCount,
      })),
      recentActivity: activity.map((a) => ({
        id: a.id,
        action: a.action,
        actor: a.actor_label,
        resourceType: a.resource_type,
        metadata: a.metadata,
        createdAt: iso(a.created_at),
      })),
    };
  });
}
