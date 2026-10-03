import { sql } from '@aegis/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { iso, rowsOf } from '../core/http';
import { RANGES, rangeOf, visibleBucketIds } from '../core/visibility';
import { requireUser } from '../plugins/auth';

/**
 * Analytics for the dashboard. Activity comes from the audit log (members: their own actions,
 * admins: everyone); storage figures are scoped to the buckets the caller can see. Every series
 * is gap-filled with generate_series so charts never draw misleading straight lines across holes.
 */
export function analyticsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Querystring: { range?: string } }>('/api/analytics/overview', async (req) => {
    const { user } = requireUser(req);
    const isAdmin = user.role === 'ADMIN';
    const range = rangeOf(req.query.range);
    const { interval, step } = RANGES[range];
    const visible = visibleBucketIds(user);

    const activity = rowsOf<{
      t: Date; uploads: number; upload_bytes: number; downloads: number; download_bytes: number; deletes: number; integrity_failures: number;
    }>(
      await ctx.db.execute(sql`
        WITH bins AS (
          SELECT generate_series(date_bin(${step}::interval, now() - ${interval}::interval, 'epoch'::timestamptz),
                                 date_bin(${step}::interval, now(), 'epoch'::timestamptz), ${step}::interval) AS t
        ), ev AS (
          SELECT date_bin(${step}::interval, created_at, 'epoch'::timestamptz) AS t, action, metadata
            FROM audit_logs
           WHERE created_at >= now() - ${interval}::interval - ${step}::interval
             AND action IN ('object.upload', 'object.download', 'object.delete', 'object.integrity_failure')
             AND (${isAdmin} OR actor_id = ${user.id})
        )
        SELECT b.t,
               count(ev.action) FILTER (WHERE ev.action = 'object.upload')::int AS uploads,
               coalesce(sum((ev.metadata->>'size')::bigint) FILTER (WHERE ev.action = 'object.upload'), 0)::bigint AS upload_bytes,
               count(ev.action) FILTER (WHERE ev.action = 'object.download')::int AS downloads,
               coalesce(sum((ev.metadata->>'size')::bigint) FILTER (WHERE ev.action = 'object.download'), 0)::bigint AS download_bytes,
               count(ev.action) FILTER (WHERE ev.action = 'object.delete')::int AS deletes,
               count(ev.action) FILTER (WHERE ev.action = 'object.integrity_failure')::int AS integrity_failures
          FROM bins b LEFT JOIN ev ON ev.t = b.t
         GROUP BY b.t ORDER BY b.t`),
    );

    // bytes stored (all non-deleted versions) at the end of each bin
    const growth = rowsOf<{ t: Date; bytes: number; objects: number }>(
      await ctx.db.execute(sql`
        WITH bins AS (
          SELECT generate_series(date_bin(${step}::interval, now() - ${interval}::interval, 'epoch'::timestamptz),
                                 date_bin(${step}::interval, now(), 'epoch'::timestamptz), ${step}::interval) AS t
        ), vers AS (
          SELECT v.size, v.created_at, v.object_id,
                 CASE WHEN v.state IN ('DELETED', 'PURGED') THEN coalesce(v.deleted_at, v.created_at) END AS removed_at
            FROM object_versions v JOIN objects o ON o.id = v.object_id
           WHERE o.bucket_id IN ${visible} AND v.is_delete_marker = false AND v.state <> 'PENDING'
        )
        SELECT b.t,
               (SELECT coalesce(sum(size), 0) FROM vers
                 WHERE created_at < b.t + ${step}::interval AND (removed_at IS NULL OR removed_at >= b.t + ${step}::interval))::bigint AS bytes,
               (SELECT count(DISTINCT object_id) FROM vers
                 WHERE created_at < b.t + ${step}::interval AND (removed_at IS NULL OR removed_at >= b.t + ${step}::interval))::int AS objects
          FROM bins b ORDER BY b.t`),
    );

    const current = sql`
      SELECT v.*, o.bucket_id, o.key, least(v.target_replicas, b.default_replicas) AS baseline,
             (SELECT count(*) FROM replicas r JOIN storage_nodes n ON n.id = r.node_id
               WHERE r.version_id = v.id AND r.state = 'HEALTHY' AND n.status <> 'OFFLINE')::int AS available
        FROM objects o JOIN object_versions v ON v.id = o.current_version_id JOIN buckets b ON b.id = o.bucket_id
       WHERE o.bucket_id IN ${visible} AND v.state = 'ACTIVE'`;

    const byType = rowsOf<{ type: string; objects: number; bytes: number }>(
      await ctx.db.execute(sql`
        SELECT split_part(content_type, ';', 1) AS type, count(*)::int AS objects, sum(size)::bigint AS bytes
          FROM (${current}) c GROUP BY 1 ORDER BY bytes DESC, objects DESC LIMIT 8`),
    );
    const byBucket = rowsOf<{ bucket: string; objects: number; bytes: number }>(
      await ctx.db.execute(sql`
        SELECT b.name AS bucket, count(c.id)::int AS objects, coalesce(sum(c.size), 0)::bigint AS bytes
          FROM buckets b LEFT JOIN (${current}) c ON c.bucket_id = b.id
         WHERE b.id IN ${visible}
         GROUP BY b.name ORDER BY bytes DESC, objects DESC LIMIT 10`),
    );
    const [integrity] = rowsOf<{ healthy: number; degraded: number; unavailable: number }>(
      await ctx.db.execute(sql`
        SELECT count(*) FILTER (WHERE available >= baseline)::int AS healthy,
               count(*) FILTER (WHERE available > 0 AND available < baseline)::int AS degraded,
               count(*) FILTER (WHERE available = 0)::int AS unavailable
          FROM (${current}) c`),
    );
    const sizes = rowsOf<{ bucket: string; objects: number }>(
      await ctx.db.execute(sql`
        SELECT CASE WHEN size < 1024 THEN '< 1 KB'
                    WHEN size < 102400 THEN '1–100 KB'
                    WHEN size < 1048576 THEN '100 KB–1 MB'
                    WHEN size < 10485760 THEN '1–10 MB'
                    ELSE '≥ 10 MB' END AS bucket,
               count(*)::int AS objects
          FROM (${current}) c GROUP BY 1`),
    );
    const order = ['< 1 KB', '1–100 KB', '100 KB–1 MB', '1–10 MB', '≥ 10 MB'];
    // access classes (§9.3): what is HOT / WARM / COLD right now, and how often each is read
    const byClass = rowsOf<{ class: string; objects: number; bytes: number; reads24h: number; replicas: number }>(
      await ctx.db.execute(sql`
        SELECT c.storage_class AS class, count(*)::int AS objects, coalesce(sum(c.size), 0)::bigint AS bytes,
               coalesce(sum((SELECT sum(reads) FROM object_access a WHERE a.object_id = c.object_id AND a.hour > now() - interval '24 hours')), 0)::int AS reads24h,
               coalesce(sum(c.available), 0)::int AS replicas
          FROM (${current}) c GROUP BY 1`),
    );
    const classChanges = rowsOf<{ t: Date; promoted: number; demoted: number }>(
      await ctx.db.execute(sql`
        WITH bins AS (
          SELECT generate_series(date_bin(${step}::interval, now() - ${interval}::interval, 'epoch'::timestamptz),
                                 date_bin(${step}::interval, now(), 'epoch'::timestamptz), ${step}::interval) AS t
        ), ev AS (
          SELECT date_bin(${step}::interval, created_at, 'epoch'::timestamptz) AS t, metadata->>'to' AS to_class, metadata->>'from' AS from_class
            FROM audit_logs WHERE action = 'object.class_changed' AND created_at >= now() - ${interval}::interval - ${step}::interval
             AND metadata->>'bucket' IN (SELECT name FROM buckets WHERE id IN ${visible})
        )
        SELECT b.t,
               count(ev.t) FILTER (WHERE ev.to_class = 'HOT')::int AS promoted,
               count(ev.t) FILTER (WHERE ev.from_class = 'HOT' OR ev.to_class = 'COLD')::int AS demoted
          FROM bins b LEFT JOIN ev ON ev.t = b.t GROUP BY b.t ORDER BY b.t`),
    );
    const topDownloads = rowsOf<{ bucket: string; key: string; downloads: number; bytes: number }>(
      await ctx.db.execute(sql`
        SELECT metadata->>'bucket' AS bucket, metadata->>'key' AS key, count(*)::int AS downloads,
               coalesce(sum((metadata->>'size')::bigint), 0)::bigint AS bytes
          FROM audit_logs
         WHERE action = 'object.download' AND created_at >= now() - ${interval}::interval
           AND (${isAdmin} OR actor_id = ${user.id})
         GROUP BY 1, 2 ORDER BY downloads DESC LIMIT 5`),
    );

    const sum = (k: keyof (typeof activity)[number]) => activity.reduce((a, r) => a + Number(r[k]), 0);
    return {
      range,
      step,
      totals: {
        uploads: sum('uploads'),
        uploadBytes: sum('upload_bytes'),
        downloads: sum('downloads'),
        downloadBytes: sum('download_bytes'),
        deletes: sum('deletes'),
        integrityFailures: sum('integrity_failures'),
      },
      activity: activity.map((r) => ({
        t: iso(r.t),
        uploads: r.uploads,
        uploadBytes: Number(r.upload_bytes),
        downloads: r.downloads,
        downloadBytes: Number(r.download_bytes),
        deletes: r.deletes,
        integrityFailures: r.integrity_failures,
      })),
      storage: growth.map((r) => ({ t: iso(r.t), bytes: Number(r.bytes), objects: r.objects })),
      byType: byType.map((r) => ({ type: r.type || 'unknown', objects: r.objects, bytes: Number(r.bytes) })),
      byBucket: byBucket.map((r) => ({ bucket: r.bucket, objects: r.objects, bytes: Number(r.bytes) })),
      integrity: integrity ?? { healthy: 0, degraded: 0, unavailable: 0 },
      sizeHistogram: order.map((b) => ({ bucket: b, objects: sizes.find((s) => s.bucket === b)?.objects ?? 0 })),
      topDownloads: topDownloads.map((r) => ({ ...r, bytes: Number(r.bytes) })),
      byClass: ['HOT', 'WARM', 'COLD'].map((k) => {
        const r = byClass.find((x) => x.class === k);
        return { class: k, objects: r?.objects ?? 0, bytes: Number(r?.bytes ?? 0), reads24h: r?.reads24h ?? 0, replicas: r?.replicas ?? 0 };
      }),
      classChanges: classChanges.map((r) => ({ t: iso(r.t), promoted: r.promoted, demoted: r.demoted })),
    };
  });
}
