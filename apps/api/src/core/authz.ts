import type { Permission, UserRole } from '@aegis/shared';

const RANK: Record<Permission, number> = { READ: 1, WRITE: 2, ADMIN: 3 };

export type AccessVia = 'admin' | 'owner' | 'grant' | 'public';
export interface Access {
  level: Permission;
  via: AccessVia;
}

export interface ResolveInput {
  user: { id: string; role: UserRole } | null;
  bucket: { ownerId: string; publicRead: boolean };
  grant: Permission | null;
  /** upper bound imposed by an API key's scopes (sessions pass 'ADMIN') */
  cap: Permission;
}

/**
 * Effective bucket permission (architecture §10.2):
 *   site ADMIN -> owner -> explicit grant -> public-read (READ) -> none.
 * The result is then capped by the credential's scope.
 */
export function resolveAccess({ user, bucket, grant, cap }: ResolveInput): Access | null {
  let access: Access | null = null;
  if (user?.role === 'ADMIN') access = { level: 'ADMIN', via: 'admin' };
  else if (user && bucket.ownerId === user.id) access = { level: 'ADMIN', via: 'owner' };
  else if (user && grant) access = { level: grant, via: 'grant' };
  else if (bucket.publicRead) access = { level: 'READ', via: 'public' };

  if (!access) return null;
  if (RANK[access.level] > RANK[cap]) access = { ...access, level: cap };
  return access;
}

export const satisfies = (have: Permission, need: Permission) => RANK[have] >= RANK[need];

export function maxScope(scopes: readonly string[]): Permission {
  if (scopes.includes('admin')) return 'ADMIN';
  if (scopes.includes('write')) return 'WRITE';
  return 'READ';
}
