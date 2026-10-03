import { createHash } from 'node:crypto';

const RING_SIZE = 2 ** 48;

/** 48-bit position on the ring (first 6 bytes of SHA-256 fit exactly in a double). */
export function ringHash(input: string): number {
  return createHash('sha256').update(input).digest().readUIntBE(0, 6);
}

interface Point {
  pos: number;
  node: string;
}

/**
 * Consistent hash ring with virtual nodes.
 *
 * - Membership = every registered node (any status). Health is handled at lookup time via the
 *   `isEligible` predicate, so a flapping node does not reshuffle the whole ring.
 * - `getNodes` walks clockwise from the key and returns the first `count` DISTINCT physical
 *   nodes that are eligible.
 */
export class HashRing {
  private readonly points: Point[] = [];
  private readonly nodeIds: string[];

  constructor(nodeIds: string[], public readonly vnodes = 128) {
    this.nodeIds = [...new Set(nodeIds)];
    for (const node of this.nodeIds) {
      for (let i = 0; i < vnodes; i++) {
        this.points.push({ pos: ringHash(`${node}#${i}`), node });
      }
    }
    this.points.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : 1));
  }

  get size(): number {
    return this.nodeIds.length;
  }

  /** Index of the first point at or after `pos` (wraps to 0). */
  private lowerBound(pos: number): number {
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.points[mid]!.pos < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo === this.points.length ? 0 : lo;
  }

  getNodes(key: string, count: number, isEligible: (nodeId: string) => boolean = () => true): string[] {
    if (this.points.length === 0 || count <= 0) return [];
    const picked: string[] = [];
    const start = this.lowerBound(ringHash(key));
    for (let step = 0; step < this.points.length && picked.length < count; step++) {
      const { node } = this.points[(start + step) % this.points.length]!;
      if (!picked.includes(node) && isEligible(node)) picked.push(node);
    }
    return picked;
  }

  /** Fraction (0..1) of the ring each node owns as primary. */
  shares(): Map<string, number> {
    const result = new Map<string, number>(this.nodeIds.map((n) => [n, 0]));
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const cur = this.points[i]!;
      const prev = this.points[(i - 1 + n) % n]!;
      const arc = i === 0 ? cur.pos + (RING_SIZE - prev.pos) : cur.pos - prev.pos;
      result.set(cur.node, (result.get(cur.node) ?? 0) + arc / RING_SIZE);
    }
    return result;
  }
}
