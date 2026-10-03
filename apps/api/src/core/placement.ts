import { HashRing } from '@aegis/hashring';
import { storageNodes, type Db } from '@aegis/db';

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

/** A node can take new writes only if it is HEALTHY, recently heard from, and has room. */
export function isEligible(n: NodeRow, offlineAfterMs: number, size = 0, now = Date.now()): boolean {
  if (n.status !== 'HEALTHY') return false;
  if (!n.lastHeartbeatAt || now - n.lastHeartbeatAt.getTime() > offlineAfterMs) return false;
  return n.capacityBytes - n.usedBytes > size;
}

/** Choose `replicas` distinct eligible nodes for a placement key using the consistent hash ring. */
export async function pickNodes(db: Db, placementKey: string, opts: PlacementOptions): Promise<NodeRow[]> {
  const nodes = await db.select().from(storageNodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ring = ringFor(nodes, opts.vnodes);
  const ids = ring.getNodes(placementKey, opts.replicas, (id) => {
    const n = byId.get(id);
    return !!n && isEligible(n, opts.offlineAfterMs, opts.expectedSize ?? 0);
  });
  return ids.map((id) => byId.get(id)!);
}
