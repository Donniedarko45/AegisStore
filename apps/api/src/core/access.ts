import { and, bucketGrants, buckets, eq, isNull } from '@aegis/db';
import { AppError, type Permission } from '@aegis/shared';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { resolveAccess, satisfies, type Access } from './authz';

export type BucketRow = typeof buckets.$inferSelect;

/**
 * Load a bucket by name and enforce that the caller has at least `need`.
 *  - unknown / invisible bucket: 404 for signed-in users (no existence leak), 401 for anonymous
 *  - visible but insufficient permission: 403
 */
export async function requireBucket(
  ctx: AppContext,
  req: FastifyRequest,
  name: string,
  need: Permission,
): Promise<{ bucket: BucketRow; access: Access }> {
  const principal = req.principal;
  const deny = (): never => {
    throw principal ? AppError.notFound('Bucket not found') : AppError.unauthenticated();
  };

  const [bucket] = await ctx.db
    .select()
    .from(buckets)
    .where(and(eq(buckets.name, name), isNull(buckets.deletedAt)));
  if (!bucket) return deny();

  let grant: Permission | null = null;
  if (principal) {
    const [g] = await ctx.db
      .select({ p: bucketGrants.permission })
      .from(bucketGrants)
      .where(and(eq(bucketGrants.bucketId, bucket.id), eq(bucketGrants.userId, principal.user.id)));
    grant = g?.p ?? null;
  }

  const access = resolveAccess({
    user: principal ? { id: principal.user.id, role: principal.user.role } : null,
    bucket: { ownerId: bucket.ownerId, publicRead: bucket.publicRead },
    grant,
    cap: principal?.cap ?? 'READ',
  });
  if (!access) return deny();
  if (!satisfies(access.level, need)) throw AppError.forbidden(`${need} permission required on this bucket`);
  return { bucket, access };
}
