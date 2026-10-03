import { HashRing } from '@aegis/hashring';
import { sql, storageNodes, type Db } from '@aegis/db';
import { WRITABLE_STATUSES } from '@aegis/shared';

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
 * A node can take new writes only if it is HEALTHY or WARNING (HIGH_RISK nodes are being
 * evacuated, DRAINING ones emptied), recently heard from, and has room.
 * `fresh` must be computed by the database (heartbeat timestamps are written with the DB clock).
 */
export function isEligible(n: NodeRow, fresh: boolean, size = 0): boolean {
  if (!WRITABLE_STATUSES.includes(n.status) || !fresh) return false;
  return n.capacityBytes - n.usedBytes > size;
}

/** Choose `replicas` distinct eligible nodes for a placement key using the consistent hash ring. */
export async function pickNodes(db: Db, placementKey: string, opts: PlacementOptions & { exclude?: Set<string> }): Promise<NodeRow[]> {
  const rows = await db
    .select({
      node: storageNodes,
      fresh: sql<boolean>`coalesce(${storageNodes.lastHeartbeatAt} > now() - make_interval(secs => ${opts.offlineAfterMs / 1000}), false)`,
    })
    .from(storageNodes);
  const byId = new Map(rows.map((r) => [r.node.id, r]));
  const ring = ringFor(rows.map((r) => r.node), opts.vnodes);
  const room = (r: (typeof rows)[number]) => r.node.capacityBytes - r.node.usedBytes > (opts.expectedSize ?? 0);
  const ids = ring.getNodes(placementKey, opts.replicas, (id) => {
    const r = byId.get(id);
    return !!r && !opts.exclude?.has(id) && isEligible(r.node, r.fresh, opts.expectedSize ?? 0);
  });
  if (ids.length < opts.replicas) {
    // A risk *prediction* must never cause a write outage: when there are not enough HEALTHY /
    // WARNING nodes, fall back to reachable HIGH_RISK ones (never OFFLINE or DRAINING). The
    // self-healing worker moves those copies off again once better nodes are available.
    const chosen = new Set(ids);
    ids.push(
      ...ring.getNodes(placementKey, opts.replicas - ids.length, (id) => {
        const r = byId.get(id);
        return !!r && !chosen.has(id) && !opts.exclude?.has(id) && r.fresh && r.node.status === 'HIGH_RISK' && room(r);
      }),
    );
  }
  return ids.map((id) => byId.get(id)!.node);
}
