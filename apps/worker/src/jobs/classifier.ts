import { sql } from '@aegis/db';
import { publish, rows, systemAudit, type WorkerCtx } from '../util';

export interface ClassifyConfig {
  hotReads24h: number;
  hotReads7d: number;
  /** a HOT object must stay below the thresholds this long before it is demoted */
  hotDemoteHours: number;
  coldAfterDays: number;
  hotReplicas: number;
}

interface Change {
  object_id: string;
  version_id: string;
  bucket: string;
  key: string;
  from_class: string;
  to_class: string;
  from_target: number;
  to_target: number;
  reads_24h: number;
  reads_7d: number;
}

/**
 * HOT / WARM / COLD classification from access frequency (architecture §9.3) and adaptive
 * replication (§9.4): HOT objects get an extra replica (spread read load, more fault tolerance),
 * WARM and COLD keep the bucket baseline. Promotion is immediate, demotion is slow (hysteresis),
 * and new objects start WARM. Only the target changes here; the reconciler adds or trims copies.
 */
export async function classifyObjects(ctx: WorkerCtx, cfg: ClassifyConfig) {
  // 1. remember when each object last qualified as HOT
  await ctx.db.execute(sql`
    UPDATE objects o SET last_hot_at = now()
      FROM (SELECT object_id,
                   sum(reads) FILTER (WHERE hour > now() - interval '24 hours') AS r24,
                   sum(reads) AS r7
              FROM object_access WHERE hour > now() - interval '7 days' GROUP BY object_id) a
     WHERE a.object_id = o.id AND (a.r24 >= ${cfg.hotReads24h} OR a.r7 >= ${cfg.hotReads7d})`);

  // 2. derive the class and replica target of every current version, write only what changed
  const changes = rows<Change>(
    await ctx.db.execute(sql`
      WITH stats AS (
        SELECT object_id,
               coalesce(sum(reads) FILTER (WHERE hour > now() - interval '24 hours'), 0)::int AS r24,
               coalesce(sum(reads) FILTER (WHERE hour > now() - interval '7 days'), 0)::int AS r7
          FROM object_access WHERE hour > now() - make_interval(days => greatest(7, ${cfg.coldAfterDays})) GROUP BY object_id
      ), cls AS (
        SELECT o.id AS object_id, v.id AS version_id, b.name AS bucket, o.key, v.storage_class AS from_class, v.target_replicas AS from_target,
               coalesce(s.r24, 0) AS r24, coalesce(s.r7, 0) AS r7,
               CASE
                 WHEN o.last_hot_at > now() - make_interval(hours => ${cfg.hotDemoteHours}) THEN 'HOT'
                 WHEN coalesce(o.last_accessed_at, v.created_at) > now() - make_interval(days => ${cfg.coldAfterDays}) THEN 'WARM'
                 ELSE 'COLD'
               END AS to_class,
               b.default_replicas
          FROM objects o
          JOIN object_versions v ON v.id = o.current_version_id AND v.state = 'ACTIVE'
          JOIN buckets b ON b.id = o.bucket_id
          LEFT JOIN stats s ON s.object_id = o.id
      ), targeted AS (
        SELECT *, CASE WHEN to_class = 'HOT'
                       THEN greatest(default_replicas, least(${cfg.hotReplicas}, (SELECT count(*) FROM storage_nodes)::int))
                       ELSE default_replicas END AS to_target
          FROM cls
      ), upd AS (
        UPDATE object_versions v SET storage_class = t.to_class, target_replicas = t.to_target
          FROM targeted t
         WHERE v.id = t.version_id AND (v.storage_class <> t.to_class OR v.target_replicas <> t.to_target)
        RETURNING t.*
      )
      SELECT object_id, version_id, bucket, key, from_class, to_class, from_target, to_target, r24 AS reads_24h, r7 AS reads_7d FROM upd`),
  );
  if (!changes.length) return { changed: 0 };

  await ctx.db.execute(sql`
    UPDATE objects SET class_changed_at = now()
     WHERE id IN (${sql.join(changes.map((c) => sql`${c.object_id}::uuid`), sql`, `)})`);
  for (const c of changes) {
    if (c.from_class === c.to_class) continue; // only the target moved (e.g. bucket default changed)
    await systemAudit(ctx, 'classifier', 'object.class_changed', { type: 'object', id: c.object_id }, {
      bucket: c.bucket,
      key: c.key,
      from: c.from_class,
      to: c.to_class,
      targetReplicas: c.to_target,
      reads24h: c.reads_24h,
      reads7d: c.reads_7d,
    });
    void publish(ctx.redis, 'object.class_changed', { bucket: c.bucket, key: c.key, from: c.from_class, to: c.to_class, targetReplicas: c.to_target });
  }
  ctx.log.info({ changed: changes.length }, 'storage classes updated');
  return { changed: changes.length };
}

/** Access counters older than the classification horizon are not needed any more. */
export async function pruneAccess(ctx: WorkerCtx, keepDays: number) {
  await ctx.db.execute(sql`DELETE FROM object_access WHERE hour < now() - make_interval(days => ${keepDays})`);
}
