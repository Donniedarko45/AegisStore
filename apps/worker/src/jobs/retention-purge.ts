import { appendAudit, sql, type Db } from '@aegis/db';
import type { StorageClient } from '@aegis/nodeclient';
import type { Logger } from 'pino';

interface DueVersion {
  id: string;
  blob_id: string | null;
}
interface ReplicaLoc {
  version_id: string;
  node_id: string;
  node_name: string;
  base_url: string;
}

const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

/**
 * Physically remove data whose retention window has passed (DELETED + purge_after <= now, not
 * protected, or protected only until a time that has passed). Blobs can be shared by several versions (restore re-uses the blob), so a blob is only
 * deleted from the nodes when EVERY version referencing it is being purged. A node that cannot be
 * reached keeps its replica row and the version stays DELETED, so the next run retries; nothing is
 * marked PURGED while bytes may still exist on disk.
 */
export async function purgeExpired(db: Db, storage: StorageClient, log: Logger, batch = 200) {
  const due = rows<DueVersion>(
    await db.execute(sql`
      SELECT id, blob_id FROM object_versions
       WHERE state = 'DELETED' AND purge_after <= now()
         AND (is_protected = false OR protected_until <= now())
       ORDER BY purge_after LIMIT ${batch}`),
  );
  if (due.length === 0) return { purged: 0, blobsDeleted: 0, pending: 0 };

  const groups = new Map<string, string[]>();
  const markers: string[] = [];
  for (const v of due) {
    if (!v.blob_id) markers.push(v.id);
    else groups.set(v.blob_id, [...(groups.get(v.blob_id) ?? []), v.id]);
  }

  let purged = 0;
  let blobsDeleted = 0;
  let pending = 0;

  const markPurged = async (ids: string[]) => {
    if (!ids.length) return;
    const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM replicas WHERE version_id IN (${idList})`);
      await tx.execute(sql`UPDATE object_versions SET state = 'PURGED' WHERE id IN (${idList})`);
    });
    purged += ids.length;
  };

  await markPurged(markers); // delete markers / failed versions with no bytes

  for (const [blobId, ids] of groups) {
    const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const [shared] = rows<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM object_versions
         WHERE blob_id = ${blobId} AND state <> 'PURGED' AND id NOT IN (${idList})`),
    );
    if ((shared?.n ?? 0) > 0) {
      // another live/restorable version still needs these bytes: drop only our references
      await markPurged(ids);
      continue;
    }

    const locs = rows<ReplicaLoc>(
      await db.execute(sql`
        SELECT r.version_id, r.node_id, n.name AS node_name, n.base_url
          FROM replicas r JOIN storage_nodes n ON n.id = r.node_id
         WHERE r.version_id IN (${idList})`),
    );
    const nodes = new Map(locs.map((l) => [l.node_id, l]));
    const failed: string[] = [];
    for (const n of nodes.values()) {
      const ok = await storage.tryDeleteBlob({ id: n.node_id, name: n.node_name, baseUrl: n.base_url }, blobId);
      if (ok) {
        await db.execute(sql`DELETE FROM replicas WHERE node_id = ${n.node_id} AND version_id IN (${idList})`);
      } else failed.push(n.node_name);
    }
    if (failed.length) {
      pending += ids.length;
      log.warn({ blobId, failed }, 'purge postponed: node unreachable, will retry');
      continue;
    }
    blobsDeleted++;
    await markPurged(ids);
  }

  if (purged > 0) {
    log.info({ purged, blobsDeleted, pending }, 'retention purge');
    await appendAudit(db, {
      actorId: null,
      actorType: 'SYSTEM',
      actorLabel: 'retention-purger',
      action: 'retention.purge',
      resourceType: 'system',
      resourceId: null,
      metadata: { versionsPurged: purged, blobsDeleted, postponed: pending },
      requestId: null,
    });
  }
  return { purged, blobsDeleted, pending };
}
