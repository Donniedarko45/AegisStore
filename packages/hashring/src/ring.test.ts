import { describe, expect, it } from 'vitest';
import { HashRing } from './index';

const keys = Array.from({ length: 6000 }, (_, i) => `bucket/object-${i}.bin`);

describe('HashRing', () => {
  it('is deterministic', () => {
    const a = new HashRing(['n1', 'n2', 'n3']);
    const b = new HashRing(['n3', 'n1', 'n2']);
    for (const k of keys.slice(0, 200)) expect(a.getNodes(k, 2)).toEqual(b.getNodes(k, 2));
  });

  it('returns distinct physical nodes', () => {
    const ring = new HashRing(['n1', 'n2', 'n3']);
    for (const k of keys.slice(0, 500)) {
      const nodes = ring.getNodes(k, 2);
      expect(nodes).toHaveLength(2);
      expect(new Set(nodes).size).toBe(2);
    }
  });

  it('never returns more nodes than exist', () => {
    const ring = new HashRing(['n1', 'n2']);
    expect(ring.getNodes('k', 5)).toHaveLength(2);
  });

  it('skips ineligible nodes and falls through to the next one', () => {
    const ring = new HashRing(['n1', 'n2', 'n3']);
    for (const k of keys.slice(0, 300)) {
      const nodes = ring.getNodes(k, 2, (id) => id !== 'n2');
      expect(nodes).toHaveLength(2);
      expect(nodes).not.toContain('n2');
    }
  });

  it('returns fewer than requested when too few nodes are eligible', () => {
    const ring = new HashRing(['n1', 'n2', 'n3']);
    expect(ring.getNodes('k', 2, (id) => id === 'n1')).toEqual(['n1']);
  });

  it('spreads keys roughly evenly with 128 vnodes', () => {
    const ring = new HashRing(['n1', 'n2', 'n3'], 128);
    const counts: Record<string, number> = { n1: 0, n2: 0, n3: 0 };
    for (const k of keys) counts[ring.getNodes(k, 1)[0]!]!++;
    for (const c of Object.values(counts)) {
      expect(c / keys.length).toBeGreaterThan(0.22);
      expect(c / keys.length).toBeLessThan(0.45);
    }
  });

  it('shares sum to 1', () => {
    const ring = new HashRing(['n1', 'n2', 'n3']);
    const total = [...ring.shares().values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('moves a minority of keys when a node is added (consistency)', () => {
    const before = new HashRing(['n1', 'n2', 'n3']);
    const after = new HashRing(['n1', 'n2', 'n3', 'n4']);
    let moved = 0;
    for (const k of keys) if (before.getNodes(k, 1)[0] !== after.getNodes(k, 1)[0]) moved++;
    // ideal is 25%; allow slack for vnode variance, but far below the ~75% of modulo hashing
    expect(moved / keys.length).toBeLessThan(0.4);
  });
});
