import { HashRing } from '@aegis/hashring';
import { sql, storageNodes, type Db } from '@aegis/db';

export type NodeRow = typeof storageNodes.$inferSelect;

const ringCache = new Map<string, HashRing>();

/** Rings are cheap but not free (nodes * vnodes hashes); cache by membership. */
export function ringFor(nodes: Pick<NodeRow, 'id' | 'vnodeCount'>[], vnodes: number): HashRing {
  const key = `${vnodes}:${nodes.map((n) => n.id).sort().join(',')}`;
  let ring = ringCache.get(key);
  if (!ring) {
    ring = new HashRing(nodes.map((n) => n.id), vnodes);
    ringCache.clear(); // membership changes are rare; keep at most one ring
    ringCache.set(key, ring);
  }
  return ring;
}

export interface PlacementOptions {
  replicas: number;
  vnodes: number;
  offlineAfterMs: number;
  expectedSize?: number;
}

/**
 * A node can take new writes only if it is HEALTHY, recently heard from, and has room.
 * `fresh` must be computed by the database (heartbeat timestamps are written with the DB clock).
 */
export function isEligible(n: NodeRow, fresh: boolean, size = 0): boolean {
  if (n.status !== 'HEALTHY' || !fresh) return false;
  return n.capacityBytes - n.usedBytes > size;
}

/** Choose `replicas` distinct eligible nodes for a placement key using the consistent hash ring. */
export async function pickNodes(db: Db, placementKey: string, opts: PlacementOptions): Promise<NodeRow[]> {
  const rows = await db
    .select({
      node: storageNodes,
      fresh: sql<boolean>`coalesce(${storageNodes.lastHeartbeatAt} > now() - make_interval(secs => ${opts.offlineAfterMs / 1000}), false)`,
    })
    .from(storageNodes);
  const byId = new Map(rows.map((r) => [r.node.id, r]));
  const ring = ringFor(rows.map((r) => r.node), opts.vnodes);
  const ids = ring.getNodes(placementKey, opts.replicas, (id) => {
    const r = byId.get(id);
    return !!r && isEligible(r.node, r.fresh, opts.expectedSize ?? 0);
  });
  return ids.map((id) => byId.get(id)!.node);
}
