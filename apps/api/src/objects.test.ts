import { describe, expect, it } from 'vitest';
import { listObjectsQuerySchema, validateObjectKey } from '@aegis/shared';
import { integrityOf } from './modules/objects';

describe('integrityOf', () => {
  it('HEALTHY when every target replica is available', () => {
    expect(integrityOf(2, 2)).toBe('HEALTHY');
    expect(integrityOf(3, 2)).toBe('HEALTHY');
  });
  it('DEGRADED when some but not all replicas are available', () => {
    expect(integrityOf(1, 2)).toBe('DEGRADED');
  });
  it('UNAVAILABLE when none are', () => {
    expect(integrityOf(0, 2)).toBe('UNAVAILABLE');
  });
});

describe('validateObjectKey', () => {
  it.each(['a.txt', 'docs/2026/report.pdf', 'sp ace/ünï.bin', 'a'.repeat(1024)])('accepts %s', (k) => {
    expect(validateObjectKey(k)).toBe(k);
  });
  it.each(['', '/abs', '../x', 'a/../b', './x', 'a/./b', 'bad\u0000key', 'x'.repeat(1025)])('rejects %j', (k) => {
    expect(() => validateObjectKey(k)).toThrow();
  });
});

describe('listObjectsQuerySchema', () => {
  it('applies defaults and coerces numbers', () => {
    const q = listObjectsQuerySchema.parse({ page: '2', pageSize: '10' });
    expect(q).toMatchObject({ page: 2, pageSize: 10, sort: 'createdAt', order: 'desc' });
  });
  it('caps page size', () => {
    expect(() => listObjectsQuerySchema.parse({ pageSize: '1000' })).toThrow();
  });
});
