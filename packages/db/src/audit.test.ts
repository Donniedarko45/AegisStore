import { describe, expect, it } from 'vitest';
import { canonicalJson } from './audit';

describe('canonicalJson', () => {
  it('ignores key order (jsonb round-trips reorder keys)', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }),
    );
  });
  it('distinguishes different values', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });
  it('handles primitives and arrays', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson([1, 'a', null])).toBe('[1,"a",null]');
  });
});
