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

  await db.execute(sql`DELETE FROM sessions WHERE expires_at < now()`);
  await db.execute(sql`DELETE FROM node_metrics WHERE ts < now() - make_interval(days => ${metricsRetentionDays})`);
}
