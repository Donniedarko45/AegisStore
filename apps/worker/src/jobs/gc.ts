import { sql, type Db } from '@aegis/db';
import { StorageClient } from '@aegis/nodeclient';
import type { Logger } from 'pino';

interface OrphanReplica {
  version_id: string;
  blob_id: string | null;
  node_name: string;
  base_url: string;
  node_id: string;
}

/**
 * Housekeeping:
 *  - uploads that never finished (PENDING > 1h, e.g. API crashed mid-upload): delete any blob that
 *    may have been committed on the nodes, then drop the rows
 *  - expired sessions, old metric samples
 */
export async function runGc(db: Db, storage: StorageClient, log: Logger, metricsRetentionDays: number) {
  const rows = (
    (await db.execute(sql`
      SELECT v.id AS version_id, v.blob_id, n.name AS node_name, n.base_url, n.id AS node_id
        FROM object_versions v
        JOIN replicas r ON r.version_id = v.id
        JOIN storage_nodes n ON n.id = r.node_id
       WHERE v.state = 'PENDING' AND v.created_at < now() - interval '1 hour'`)) as unknown as { rows: OrphanReplica[] }
  ).rows;

  for (const r of rows) {
    if (r.blob_id) await storage.deleteBlob({ id: r.node_id, name: r.node_name, baseUrl: r.base_url }, r.blob_id);
  }
  const removed = await db.execute(sql`
    DELETE FROM object_versions WHERE state = 'PENDING' AND created_at < now() - interval '1 hour' RETURNING id`);
  const n = (removed as unknown as { rows: unknown[] }).rows.length;
  if (n) log.info({ count: n }, 'removed abandoned pending uploads');

  // object rows whose every upload failed before producing a version (no history, no current)
  await db.execute(sql`
    DELETE FROM objects o
     WHERE o.current_version_id IS NULL
       AND o.updated_at < now() - interval '1 hour'
       AND NOT EXISTS (SELECT 1 FROM object_versions v WHERE v.object_id = o.id)`);

  // versions protected after an attack become ordinary again when their protection window ends
  await db.execute(sql`UPDATE object_versions SET is_protected = false WHERE is_protected AND protected_until <= now()`);
  // multipart uploads nobody completed: remove their parts from the nodes
  const stale = (
    (await db.execute(sql`
      UPDATE multipart_uploads SET state = 'ABORTED' WHERE state = 'ACTIVE' AND expires_at < now()
      RETURNING id, node_ids`)) as unknown as { rows: { id: string; node_ids: string[] }[] }
  ).rows;
  for (const up of stale) {
    const nodes = (
      (await db.execute(sql`SELECT id, name, base_url FROM storage_nodes WHERE id = ANY(${up.node_ids}::uuid[])`)) as unknown as {
        rows: { id: string; name: string; base_url: string }[];
      }
    ).rows;
    await Promise.allSettled(nodes.map((n) => storage.abortParts({ id: n.id, name: n.name, baseUrl: n.base_url }, up.id)));
    await db.execute(sql`DELETE FROM multipart_parts WHERE upload_id = ${up.id}`);
  }
  if (stale.length) log.info({ count: stale.length }, 'aborted expired multipart uploads');
  await db.execute(sql`DELETE FROM share_links WHERE expires_at < now() - interval '30 days'`);
  await db.execute(sql`DELETE FROM sessions WHERE expires_at < now()`);
  await db.execute(sql`DELETE FROM node_metrics WHERE ts < now() - make_interval(days => ${metricsRetentionDays})`);
}
