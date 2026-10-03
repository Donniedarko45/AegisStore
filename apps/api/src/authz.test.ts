import { describe, expect, it } from 'vitest';
import { maxScope, resolveAccess, satisfies } from './core/authz';

const owner = { id: 'u-owner', role: 'MEMBER' as const };
const other = { id: 'u-other', role: 'MEMBER' as const };
const admin = { id: 'u-admin', role: 'ADMIN' as const };
const priv = { ownerId: owner.id, publicRead: false };
const pub = { ownerId: owner.id, publicRead: true };

describe('resolveAccess (architecture §10.2 decision table)', () => {
  it('site ADMIN has full access to any bucket', () => {
    expect(resolveAccess({ user: admin, bucket: priv, grant: null, cap: 'ADMIN' })).toEqual({ level: 'ADMIN', via: 'admin' });
  });
  it('owner has full access', () => {
    expect(resolveAccess({ user: owner, bucket: priv, grant: null, cap: 'ADMIN' })).toEqual({ level: 'ADMIN', via: 'owner' });
  });
  it('a stranger gets nothing on a private bucket', () => {
    expect(resolveAccess({ user: other, bucket: priv, grant: null, cap: 'ADMIN' })).toBeNull();
  });
  it('an explicit grant applies', () => {
    expect(resolveAccess({ user: other, bucket: priv, grant: 'WRITE', cap: 'ADMIN' })).toEqual({ level: 'WRITE', via: 'grant' });
  });
  it('grant beats public-read when higher', () => {
    expect(resolveAccess({ user: other, bucket: pub, grant: 'WRITE', cap: 'ADMIN' })?.level).toBe('WRITE');
  });
  it('public-read gives anonymous callers READ only', () => {
    expect(resolveAccess({ user: null, bucket: pub, grant: null, cap: 'READ' })).toEqual({ level: 'READ', via: 'public' });
    expect(resolveAccess({ user: null, bucket: priv, grant: null, cap: 'READ' })).toBeNull();
  });
  it('an API key scope caps the level, even for owners and admins', () => {
    expect(resolveAccess({ user: owner, bucket: priv, grant: null, cap: 'READ' })?.level).toBe('READ');
    expect(resolveAccess({ user: admin, bucket: priv, grant: null, cap: 'WRITE' })?.level).toBe('WRITE');
    expect(resolveAccess({ user: other, bucket: priv, grant: 'READ', cap: 'WRITE' })?.level).toBe('READ');
  });
});

describe('permission ordering', () => {
  it('is hierarchical READ < WRITE < ADMIN', () => {
    expect(satisfies('ADMIN', 'WRITE')).toBe(true);
    expect(satisfies('WRITE', 'READ')).toBe(true);
    expect(satisfies('READ', 'WRITE')).toBe(false);
    expect(satisfies('WRITE', 'ADMIN')).toBe(false);
  });
  it('maxScope picks the strongest scope', () => {
    expect(maxScope(['read'])).toBe('READ');
    expect(maxScope(['read', 'write'])).toBe('WRITE');
    expect(maxScope(['write', 'admin'])).toBe('ADMIN');
  });
});
