import { and, bucketGrants, buckets, eq, isNull, objectVersions, objects, sql, users } from '@aegis/db';
import {
  AppError,
  createBucketSchema,
  setGrantSchema,
  updateBucketSchema,
  type BucketDto,
} from '@aegis/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { requireBucket } from '../core/access';
import { audit } from '../core/audit';
import { isUniqueViolation, iso, parse, rowsOf } from '../core/http';
import { publishEvent } from '../core/redis';
import { requireUser } from '../plugins/auth';

interface BucketRow {
  id: string;
  name: string;
  owner_id: string;
  owner_email: string;
  versioning_enabled: boolean;
  public_read: boolean;
  created_at: Date;
  object_count: number;
  total_bytes: number;
  grant_permission: 'READ' | 'WRITE' | 'ADMIN' | null;
}

const toDto = (r: BucketRow, userId: string, isAdmin: boolean): BucketDto => ({
  id: r.id,
  name: r.name,
  ownerId: r.owner_id,
  ownerEmail: r.owner_email,
  versioningEnabled: r.versioning_enabled,
  publicRead: r.public_read,
  createdAt: iso(r.created_at)!,
  objectCount: r.object_count,
  totalBytes: Number(r.total_bytes),
  permission: isAdmin ? 'ADMIN' : r.owner_id === userId ? 'OWNER' : (r.grant_permission ?? (r.public_read ? 'READ' : undefined)),
});

export function bucketRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Querystring: { q?: string } }>('/api/buckets', async (req) => {
    const { user } = requireUser(req);
    const isAdmin = user.role === 'ADMIN';
    const q = (req.query.q ?? '').trim().toLowerCase();
    const res = await ctx.db.execute(sql`
      SELECT b.id, b.name, b.owner_id, u.email AS owner_email, b.versioning_enabled, b.public_read, b.created_at,
             coalesce(s.cnt, 0)::int AS object_count, coalesce(s.bytes, 0)::bigint AS total_bytes,
             g.permission AS grant_permission
      FROM buckets b
      JOIN users u ON u.id = b.owner_id
      LEFT JOIN bucket_grants g ON g.bucket_id = b.id AND g.user_id = ${user.id}
      LEFT JOIN LATERAL (
        SELECT count(*) AS cnt, sum(v.size) AS bytes
        FROM objects o JOIN object_versions v ON v.id = o.current_version_id
        WHERE o.bucket_id = b.id AND v.state = 'ACTIVE'
      ) s ON true
      WHERE b.deleted_at IS NULL
        AND (${isAdmin} OR b.owner_id = ${user.id} OR g.id IS NOT NULL)
        AND (${q} = '' OR position(${q} in lower(b.name)) > 0)
      ORDER BY b.created_at DESC`);
    return { items: rowsOf<BucketRow>(res).map((r) => toDto(r, user.id, isAdmin)) };
  });

  app.post('/api/buckets', async (req, reply) => {
    const { user } = requireUser(req);
    const body = parse(createBucketSchema, req.body);
    try {
      const [b] = await ctx.db
        .insert(buckets)
        .values({
          name: body.name,
          ownerId: user.id,
          versioningEnabled: body.versioningEnabled,
          publicRead: body.publicRead,
          defaultReplicas: ctx.cfg.REPLICATION_FACTOR,
        })
        .returning();
      await audit(ctx, req, { action: 'bucket.create', resourceType: 'bucket', resourceId: b!.id, metadata: { name: b!.name } });
      void publishEvent(ctx.redis, 'bucket.created', { name: b!.name });
      return reply.code(201).send({
        bucket: {
          id: b!.id,
          name: b!.name,
          ownerId: b!.ownerId,
          ownerEmail: user.email,
          versioningEnabled: b!.versioningEnabled,
          publicRead: b!.publicRead,
          createdAt: iso(b!.createdAt)!,
          objectCount: 0,
          totalBytes: 0,
          permission: 'OWNER',
        } satisfies BucketDto,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict(`Bucket name "${body.name}" is already taken`);
      throw err;
    }
  });

  app.get<{ Params: { bucket: string } }>('/api/buckets/:bucket', async (req) => {
    const { bucket, access } = await requireBucket(ctx, req, req.params.bucket, 'READ');
    const [stats] = rowsOf<{ cnt: number; bytes: number }>(
      await ctx.db.execute(sql`
        SELECT count(*)::int AS cnt, coalesce(sum(v.size), 0)::bigint AS bytes
        FROM objects o JOIN object_versions v ON v.id = o.current_version_id
        WHERE o.bucket_id = ${bucket.id} AND v.state = 'ACTIVE'`),
    );
    const [owner] = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, bucket.ownerId));
    return {
      bucket: {
        id: bucket.id,
        name: bucket.name,
        ownerId: bucket.ownerId,
        ownerEmail: owner?.email,
        versioningEnabled: bucket.versioningEnabled,
        publicRead: bucket.publicRead,
        createdAt: iso(bucket.createdAt)!,
        objectCount: stats?.cnt ?? 0,
        totalBytes: Number(stats?.bytes ?? 0),
        permission: access.via === 'owner' ? 'OWNER' : access.level,
      } satisfies BucketDto,
    };
  });

  app.patch<{ Params: { bucket: string } }>('/api/buckets/:bucket', async (req) => {
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'ADMIN');
    const body = parse(updateBucketSchema, req.body);
    const [updated] = await ctx.db
      .update(buckets)
      .set({
        ...(body.versioningEnabled !== undefined && { versioningEnabled: body.versioningEnabled }),
        ...(body.publicRead !== undefined && { publicRead: body.publicRead }),
      })
      .where(eq(buckets.id, bucket.id))
      .returning();
    await audit(ctx, req, { action: 'bucket.update', resourceType: 'bucket', resourceId: bucket.id, metadata: { name: bucket.name, changes: body } });
    return { ok: true, versioningEnabled: updated!.versioningEnabled, publicRead: updated!.publicRead };
  });

  app.delete<{ Params: { bucket: string } }>('/api/buckets/:bucket', async (req) => {
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'ADMIN');
    const [live] = rowsOf<{ n: number }>(
      await ctx.db.execute(sql`
        SELECT count(*)::int AS n
        FROM ${objects} o JOIN ${objectVersions} v ON v.id = o.current_version_id
        WHERE o.bucket_id = ${bucket.id} AND v.state = 'ACTIVE'`),
    );
    if ((live?.n ?? 0) > 0) {
      throw new AppError(409, 'BUCKET_NOT_EMPTY', `Bucket still contains ${live!.n} object(s). Delete them first.`);
    }
    // soft delete: retained (deleted) versions keep their blobs until the retention purge
    await ctx.db.update(buckets).set({ deletedAt: new Date() }).where(and(eq(buckets.id, bucket.id), isNull(buckets.deletedAt)));
    await audit(ctx, req, { action: 'bucket.delete', resourceType: 'bucket', resourceId: bucket.id, metadata: { name: bucket.name } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- grants
  app.get<{ Params: { bucket: string } }>('/api/buckets/:bucket/grants', async (req) => {
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'ADMIN');
    const rows = await ctx.db
      .select({ userId: users.id, email: users.email, name: users.name, permission: bucketGrants.permission, createdAt: bucketGrants.createdAt })
      .from(bucketGrants)
      .innerJoin(users, eq(users.id, bucketGrants.userId))
      .where(eq(bucketGrants.bucketId, bucket.id));
    return { items: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })) };
  });

  app.put<{ Params: { bucket: string } }>('/api/buckets/:bucket/grants', async (req) => {
    const { user } = requireUser(req);
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'ADMIN');
    const body = parse(setGrantSchema, req.body);
    const [target] = await ctx.db.select().from(users).where(eq(users.email, body.email));
    if (!target) throw AppError.notFound(`No user with email ${body.email}`);
    if (target.id === bucket.ownerId) throw AppError.validation('The bucket owner already has full access');
    await ctx.db
      .insert(bucketGrants)
      .values({ bucketId: bucket.id, userId: target.id, permission: body.permission, grantedBy: user.id })
      .onConflictDoUpdate({
        target: [bucketGrants.bucketId, bucketGrants.userId],
        set: { permission: body.permission, grantedBy: user.id },
      });
    await audit(ctx, req, {
      action: 'grant.set',
      resourceType: 'bucket',
      resourceId: bucket.id,
      metadata: { bucket: bucket.name, grantee: target.email, permission: body.permission },
    });
    return { ok: true };
  });

  app.delete<{ Params: { bucket: string; userId: string } }>('/api/buckets/:bucket/grants/:userId', async (req) => {
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'ADMIN');
    const deleted = await ctx.db
      .delete(bucketGrants)
      .where(and(eq(bucketGrants.bucketId, bucket.id), eq(bucketGrants.userId, req.params.userId)))
      .returning();
    if (!deleted.length) throw AppError.notFound('Grant not found');
    await audit(ctx, req, { action: 'grant.remove', resourceType: 'bucket', resourceId: bucket.id, metadata: { bucket: bucket.name, userId: req.params.userId } });
    return { ok: true };
  });
}
