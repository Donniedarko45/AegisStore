import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream';
import { and, desc, eq, inArray, notInArray, objectVersions, objects, replicas, sql, storageNodes, users } from '@aegis/db';
import {
  AppError,
  listObjectsQuerySchema,
  validateObjectKey,
  type IntegrityStatus,
  type ObjectSummaryDto,
  type ReplicaDto,
} from '@aegis/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { requireBucket, type BucketRow } from '../core/access';
import { audit } from '../core/audit';
import { fanoutStage } from '../core/fanout';
import { iso, parse, rowsOf } from '../core/http';
import { HashRing } from '@aegis/hashring';
import { pickNodes, ringFor, type NodeRow } from '../core/placement';
import { publishEvent } from '../core/redis';
import type { StagedResult } from '@aegis/nodeclient';
import { requireUser } from '../plugins/auth';

type Q = { key?: string; versionId?: string };

/**
 * Integrity is judged against the durability baseline (the bucket's replica count): a HOT object
 * whose *extra* copy is still being created is not degraded. `target` may be higher than that.
 */
export const integrityOf = (available: number, target: number, baseline = target): IntegrityStatus =>
  available >= Math.min(target, baseline) ? 'HEALTHY' : available === 0 ? 'UNAVAILABLE' : 'DEGRADED';

function keyFrom(q: Q): string {
  try {
    return validateObjectKey(q.key);
  } catch (e) {
    throw AppError.validation((e as Error).message);
  }
}

const sha256Of = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function findObject(ctx: AppContext, bucketId: string, key: string) {
  const [row] = await ctx.db
    .select()
    .from(objects)
    .where(and(eq(objects.bucketId, bucketId), eq(objects.key, key)));
  return row ?? null;
}

/** Resolve the version a read should serve: an explicit versionId, else the current version. */
async function resolveVersion(ctx: AppContext, obj: typeof objects.$inferSelect, versionId?: string) {
  const id = versionId ?? obj.currentVersionId;
  if (!id) return null;
  const [v] = await ctx.db
    .select()
    .from(objectVersions)
    .where(and(eq(objectVersions.id, id), eq(objectVersions.objectId, obj.id)));
  if (!v || v.state !== 'ACTIVE' || v.isDeleteMarker) return null;
  return v;
}

function contentDisposition(key: string): string {
  const base = key.split('/').pop() || 'download';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

function objectHeaders(reply: FastifyReply, v: typeof objectVersions.$inferSelect, key: string) {
  reply
    .header('content-type', v.contentType)
    .header('content-length', v.size)
    .header('etag', `"${v.sha256}"`)
    .header('content-disposition', contentDisposition(key))
    .header('x-content-type-options', 'nosniff')
    .header('x-aegis-sha256', v.sha256 ?? '')
    .header('x-aegis-version-id', v.id)
    .header('cache-control', 'private, no-cache');
}

// =============================================================================================
export function objectRoutes(app: FastifyInstance, ctx: AppContext) {
  registerUpload(app, ctx);

  // ------------------------------------------------------------------------------- download
  app.get<{ Params: { bucket: string }; Querystring: Q }>(
    '/api/buckets/:bucket/object',
    { exposeHeadRoute: false },
    async (req, reply) => {
      const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'READ');
      const key = keyFrom(req.query);
      const obj = await findObject(ctx, bucket.id, key);
      const version = obj ? await resolveVersion(ctx, obj, req.query.versionId) : null;
      if (!obj || !version) throw AppError.notFound('Object not found');
      return serveObject(ctx, req, reply, bucket, key, version);
    },
  );

  app.head<{ Params: { bucket: string }; Querystring: Q }>('/api/buckets/:bucket/object', async (req, reply) => {
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'READ');
    const key = keyFrom(req.query);
    const obj = await findObject(ctx, bucket.id, key);
    const version = obj ? await resolveVersion(ctx, obj, req.query.versionId) : null;
    if (!version) return reply.code(404).send();
    objectHeaders(reply, version, key);
    return reply.code(200).send();
  });

  // ---------------------------------------------------------------------------------- delete
  app.delete<{ Params: { bucket: string }; Querystring: Q }>('/api/buckets/:bucket/object', async (req) => {
    requireUser(req);
    const specificVersion = !!req.query.versionId;
    // deleting a single version is destructive for history, so it needs ADMIN on the bucket
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, specificVersion ? 'ADMIN' : 'WRITE');
    const key = keyFrom(req.query);
    const obj = await findObject(ctx, bucket.id, key);
    if (!obj) throw AppError.notFound('Object not found');
    const purgeAfter = new Date(Date.now() + ctx.cfg.RETENTION_HOURS * 3_600_000);

    if (specificVersion) {
      const [v] = await ctx.db
        .select()
        .from(objectVersions)
        .where(and(eq(objectVersions.id, req.query.versionId!), eq(objectVersions.objectId, obj.id)));
      if (!v || v.state !== 'ACTIVE') throw AppError.notFound('Version not found');
      if (v.isProtected) throw AppError.conflict('This version is protected and cannot be deleted');
      await ctx.db.transaction(async (tx) => {
        await tx.update(objectVersions).set({ state: 'DELETED', deletedAt: new Date(), purgeAfter }).where(eq(objectVersions.id, v.id));
        if (obj.currentVersionId === v.id) {
          const [next] = await tx
            .select({ id: objectVersions.id })
            .from(objectVersions)
            .where(and(eq(objectVersions.objectId, obj.id), eq(objectVersions.state, 'ACTIVE'), eq(objectVersions.isDeleteMarker, false)))
            .orderBy(desc(objectVersions.versionNo))
            .limit(1);
          await tx.update(objects).set({ currentVersionId: next?.id ?? null, updatedAt: new Date() }).where(eq(objects.id, obj.id));
        }
      });
      await audit(ctx, req, { action: 'object.delete_version', resourceType: 'object', resourceId: obj.id, metadata: { bucket: bucket.name, key, versionId: v.id } });
      return { ok: true };
    }

    if (!obj.currentVersionId) throw AppError.notFound('Object not found');
    await ctx.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(objects).where(eq(objects.id, obj.id)).for('update');
      if (!locked?.currentVersionId) return;
      if (bucket.versioningEnabled) {
        // keep history: a delete marker becomes the newest version, older versions stay recoverable
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`coalesce(max(${objectVersions.versionNo}), 0)::int` })
          .from(objectVersions)
          .where(eq(objectVersions.objectId, obj.id));
        await tx.insert(objectVersions).values({
          objectId: obj.id,
          versionNo: n + 1,
          isDeleteMarker: true,
          state: 'ACTIVE',
          size: 0,
          createdBy: req.principal!.user.id,
          targetReplicas: 0,
        });
      } else {
        await tx
          .update(objectVersions)
          .set({ state: 'DELETED', deletedAt: new Date(), purgeAfter })
          .where(eq(objectVersions.id, locked.currentVersionId));
      }
      await tx.update(objects).set({ currentVersionId: null, updatedAt: new Date() }).where(eq(objects.id, obj.id));
    });
    await audit(ctx, req, { action: 'object.delete', resourceType: 'object', resourceId: obj.id, metadata: { bucket: bucket.name, key, versioned: bucket.versioningEnabled } });
    void publishEvent(ctx.redis, 'object.deleted', { bucket: bucket.name, key });
    return { ok: true };
  });

  // --------------------------------------------------------------------------------- restore
  // Makes an older version current again by creating a NEW version that shares the old blob (no
  // byte copy). The source may be an ACTIVE non-current version or a DELETED one still inside the
  // retention window, which makes this "undo delete" for unversioned buckets too.
  app.post<{ Params: { bucket: string }; Querystring: Q }>('/api/buckets/:bucket/object/restore', async (req) => {
    const principal = requireUser(req);
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'WRITE');
    const key = keyFrom(req.query);
    if (!req.query.versionId) throw AppError.validation('versionId is required');
    const obj = await findObject(ctx, bucket.id, key);
    if (!obj) throw AppError.notFound('Object not found');

    const [source] = await ctx.db
      .select()
      .from(objectVersions)
      .where(and(eq(objectVersions.id, req.query.versionId), eq(objectVersions.objectId, obj.id)));
    if (!source || source.isDeleteMarker || !source.blobId || (source.state !== 'ACTIVE' && source.state !== 'DELETED')) {
      throw AppError.notFound('Version not found or no longer restorable');
    }
    if (source.id === obj.currentVersionId) throw AppError.conflict('This version is already current');

    const healthy = await ctx.db
      .select()
      .from(replicas)
      .where(and(eq(replicas.versionId, source.id), eq(replicas.state, 'HEALTHY')));
    if (healthy.length === 0) throw new AppError(409, 'STORAGE_UNAVAILABLE', 'No healthy replica of that version remains');

    const purgeAfter = new Date(Date.now() + ctx.cfg.RETENTION_HOURS * 3_600_000);
    const restored = await ctx.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(objects).where(eq(objects.id, obj.id)).for('update');
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`coalesce(max(${objectVersions.versionNo}), 0)::int` })
        .from(objectVersions)
        .where(eq(objectVersions.objectId, obj.id));
      const [created] = await tx
        .insert(objectVersions)
        .values({
          objectId: obj.id,
          versionNo: n + 1,
          size: source.size,
          contentType: source.contentType,
          sha256: source.sha256,
          blobId: source.blobId,
          state: 'ACTIVE',
          storageClass: source.storageClass,
          targetReplicas: source.targetReplicas,
          createdBy: principal.user.id,
        })
        .returning();
      await tx.insert(replicas).values(
        healthy.map((r) => ({ versionId: created!.id, nodeId: r.nodeId, blobPath: r.blobPath, sha256: r.sha256, state: 'HEALTHY' as const, lastVerifiedAt: r.lastVerifiedAt })),
      );
      if (locked?.currentVersionId && !bucket.versioningEnabled) {
        await tx
          .update(objectVersions)
          .set({ state: 'DELETED', deletedAt: new Date(), purgeAfter })
          .where(and(eq(objectVersions.id, locked.currentVersionId), eq(objectVersions.state, 'ACTIVE')));
      }
      await tx.update(objects).set({ currentVersionId: created!.id, updatedAt: new Date() }).where(eq(objects.id, obj.id));
      return created!;
    });

    await audit(ctx, req, {
      action: 'object.restore',
      resourceType: 'object',
      resourceId: obj.id,
      metadata: { bucket: bucket.name, key, fromVersionNo: source.versionNo, fromState: source.state, newVersionNo: restored.versionNo },
    });
    void publishEvent(ctx.redis, 'object.created', { bucket: bucket.name, key, restored: true });
    return { ok: true, versionId: restored.id, versionNo: restored.versionNo };
  });

  // ------------------------------------------------------------------------- recently deleted
  // Objects with no current version whose latest real version still exists: DELETED (unversioned
  // bucket, restorable until purge_after) or ACTIVE behind a delete marker (versioned bucket).
  app.get<{ Params: { bucket: string } }>('/api/buckets/:bucket/objects/deleted', async (req) => {
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'READ');
    const rows = rowsOf<{
      key: string; version_id: string; version_no: number; size: number; content_type: string; sha256: string;
      deleted_at: Date | null; purge_after: Date | null; updated_at: Date;
    }>(
      await ctx.db.execute(sql`
        SELECT o.key, v.id AS version_id, v.version_no, v.size, v.content_type, v.sha256, v.deleted_at, v.purge_after,
               o.updated_at
          FROM ${objects} o
          JOIN LATERAL (
            SELECT * FROM ${objectVersions} x
             WHERE x.object_id = o.id AND x.is_delete_marker = false AND x.state IN ('ACTIVE', 'DELETED')
             ORDER BY x.version_no DESC LIMIT 1
          ) v ON true
         WHERE o.bucket_id = ${bucket.id} AND o.current_version_id IS NULL
         ORDER BY coalesce(v.deleted_at, o.updated_at) DESC
         LIMIT 500`),
    );
    return {
      items: rows.map((r) => ({
        key: r.key,
        versionId: r.version_id,
        versionNo: r.version_no,
        size: Number(r.size),
        contentType: r.content_type,
        sha256: r.sha256,
        deletedAt: iso(r.deleted_at ?? r.updated_at),
        purgeAfter: iso(r.purge_after),
      })),
    };
  });

  // -------------------------------------------------------------------------------- listing
  app.get<{ Params: { bucket: string } }>('/api/buckets/:bucket/objects', async (req) => {
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'READ');
    const q = parse(listObjectsQuerySchema, req.query);

    const sortCol = { key: sql`t.key`, size: sql`t.size`, createdAt: sql`t.created_at` }[q.sort];
    const dir = q.order === 'asc' ? sql`ASC` : sql`DESC`;
    const res = await ctx.db.execute(sql`
      SELECT * FROM (
        SELECT o.key, v.id AS version_id, v.version_no, v.size, v.content_type, v.sha256, v.storage_class,
               v.target_replicas, v.created_at,
               (SELECT count(*) FROM ${replicas} r JOIN ${storageNodes} n ON n.id = r.node_id
                 WHERE r.version_id = v.id AND r.state = 'HEALTHY' AND n.status <> 'OFFLINE')::int AS available
        FROM ${objects} o JOIN ${objectVersions} v ON v.id = o.current_version_id
        WHERE o.bucket_id = ${bucket.id} AND v.state = 'ACTIVE'
          AND (${q.prefix ?? null}::text IS NULL OR starts_with(o.key, ${q.prefix ?? ''}))
          AND (${q.q ?? null}::text IS NULL OR position(lower(${q.q ?? ''}) in lower(o.key)) > 0)
          AND (${q.class ?? null}::text IS NULL OR v.storage_class = ${q.class ?? ''})
          AND (${q.delimiter ?? null}::text IS NULL OR position('/' in substr(o.key, length(${q.prefix ?? ''}::text) + 1)) = 0)
      ) t
      WHERE (${q.integrity ?? null}::text IS NULL OR
             (CASE WHEN t.available >= least(t.target_replicas, ${bucket.defaultReplicas}) THEN 'HEALTHY'
                   WHEN t.available = 0 THEN 'UNAVAILABLE' ELSE 'DEGRADED' END) = ${q.integrity ?? ''})
      ORDER BY ${sortCol} ${dir}, t.key ASC
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`);

    // total is computed separately so an out-of-range page still reports the right count
    const [{ total } = { total: 0 }] = rowsOf<{ total: number }>(
      await ctx.db.execute(sql`
        SELECT count(*)::int AS total FROM (
          SELECT v.target_replicas,
                 (SELECT count(*) FROM ${replicas} r JOIN ${storageNodes} n ON n.id = r.node_id
                   WHERE r.version_id = v.id AND r.state = 'HEALTHY' AND n.status <> 'OFFLINE')::int AS available
          FROM ${objects} o JOIN ${objectVersions} v ON v.id = o.current_version_id
          WHERE o.bucket_id = ${bucket.id} AND v.state = 'ACTIVE'
            AND (${q.prefix ?? null}::text IS NULL OR starts_with(o.key, ${q.prefix ?? ''}))
            AND (${q.q ?? null}::text IS NULL OR position(lower(${q.q ?? ''}) in lower(o.key)) > 0)
            AND (${q.class ?? null}::text IS NULL OR v.storage_class = ${q.class ?? ''})
            AND (${q.delimiter ?? null}::text IS NULL OR position('/' in substr(o.key, length(${q.prefix ?? ''}::text) + 1)) = 0)
        ) t
        WHERE (${q.integrity ?? null}::text IS NULL OR
               (CASE WHEN t.available >= least(t.target_replicas, ${bucket.defaultReplicas}) THEN 'HEALTHY'
                     WHEN t.available = 0 THEN 'UNAVAILABLE' ELSE 'DEGRADED' END) = ${q.integrity ?? ''})`),
    );

    type Row = {
      key: string; version_id: string; version_no: number; size: number; content_type: string; sha256: string;
      storage_class: ObjectSummaryDto['storageClass']; target_replicas: number; created_at: Date; available: number;
    };
    const items: ObjectSummaryDto[] = rowsOf<Row>(res).map((r) => ({
      key: r.key,
      versionId: r.version_id,
      versionNo: r.version_no,
      size: Number(r.size),
      contentType: r.content_type,
      sha256: r.sha256,
      storageClass: r.storage_class,
      integrity: integrityOf(r.available, r.target_replicas, bucket.defaultReplicas),
      availableReplicas: r.available,
      targetReplicas: r.target_replicas,
      createdAt: iso(r.created_at)!,
    }));
    // folders ("common prefixes") directly below the current prefix
    let prefixes: { prefix: string; objects: number; bytes: number }[] = [];
    if (q.delimiter) {
      prefixes = rowsOf<{ prefix: string; objects: number; bytes: number }>(
        await ctx.db.execute(sql`
          SELECT ${q.prefix ?? ''} || split_part(substr(o.key, length(${q.prefix ?? ''}::text) + 1), '/', 1) || '/' AS prefix,
                 count(*)::int AS objects, coalesce(sum(v.size), 0)::bigint AS bytes
            FROM ${objects} o JOIN ${objectVersions} v ON v.id = o.current_version_id
           WHERE o.bucket_id = ${bucket.id} AND v.state = 'ACTIVE'
             AND starts_with(o.key, ${q.prefix ?? ''})
             -- the offset is measured by Postgres itself so it always matches substr() (JS .length
             -- counts UTF-16 units, the database may count code points or bytes)
             AND position('/' in substr(o.key, length(${q.prefix ?? ''}::text) + 1)) > 0
           GROUP BY 1 ORDER BY 1 LIMIT 1000`),
      ).map((r) => ({ ...r, bytes: Number(r.bytes) }));
    }
    return { items, prefixes, total, page: q.page, pageSize: q.pageSize };
  });

  // -------------------------------------------------------------------------------- details
  app.get<{ Params: { bucket: string }; Querystring: Q }>('/api/buckets/:bucket/object/details', async (req) => {
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'READ');
    const key = keyFrom(req.query);
    const obj = await findObject(ctx, bucket.id, key);
    if (!obj) throw AppError.notFound('Object not found');

    const versionRows = await ctx.db
      .select({ v: objectVersions, createdByEmail: users.email })
      .from(objectVersions)
      .leftJoin(users, eq(users.id, objectVersions.createdBy))
      .where(eq(objectVersions.objectId, obj.id))
      .orderBy(desc(objectVersions.versionNo));

    const current = versionRows.find((r) => r.v.id === obj.currentVersionId)?.v ?? null;
    let replicaDtos: ReplicaDto[] = [];
    let integrity: IntegrityStatus = 'UNAVAILABLE';
    if (current) {
      const rs = await ctx.db
        .select({ r: replicas, node: storageNodes })
        .from(replicas)
        .innerJoin(storageNodes, eq(storageNodes.id, replicas.nodeId))
        .where(eq(replicas.versionId, current.id));
      replicaDtos = rs.map(({ r, node }) => ({
        id: r.id,
        nodeId: node.id,
        nodeName: node.name,
        nodeStatus: node.status,
        state: r.state,
        blobPath: `${node.name}/${r.blobPath}`,
        sha256: r.sha256,
        checksumMatch: r.state === 'HEALTHY' && r.sha256 === current.sha256,
        lastVerifiedAt: iso(r.lastVerifiedAt),
      }));
      const available = rs.filter(({ r, node }) => r.state === 'HEALTHY' && node.status !== 'OFFLINE').length;
      integrity = integrityOf(available, current.targetReplicas, bucket.defaultReplicas);
    }

    let placement: { key: string; ringPos: number; ringOrder: string[] } | null = null;
    if (current) {
      const placementKey = `${bucket.id}/${key}@${current.id}`;
      const all = await ctx.db.select().from(storageNodes);
      const names = new Map(all.map((n) => [n.id, n.name]));
      placement = {
        key: placementKey,
        ringPos: HashRing.position(placementKey),
        // clockwise order of distinct nodes from the key (what placement would pick if all were healthy)
        ringOrder: ringFor(all, ctx.cfg.VNODES_PER_NODE).getNodes(placementKey, all.length).map((id) => names.get(id) ?? id),
      };
    }

    const hourly = rowsOf<{ hour: Date; reads: number }>(
      await ctx.db.execute(sql`
        SELECT h AS hour, coalesce(a.reads, 0)::int AS reads
          FROM generate_series(date_trunc('hour', now()) - interval '47 hours', date_trunc('hour', now()), interval '1 hour') h
          LEFT JOIN object_access a ON a.object_id = ${obj.id} AND a.hour = h
         ORDER BY h`),
    );
    const [totals] = rowsOf<{ r24: number; r7: number }>(
      await ctx.db.execute(sql`
        SELECT coalesce(sum(reads) FILTER (WHERE hour > now() - interval '24 hours'), 0)::int AS r24,
               coalesce(sum(reads), 0)::int AS r7
          FROM object_access WHERE object_id = ${obj.id} AND hour > now() - interval '7 days'`),
    );

    return {
      key,
      bucket: bucket.name,
      placement,
      access: {
        reads24h: totals?.r24 ?? 0,
        reads7d: totals?.r7 ?? 0,
        lastAccessedAt: iso(obj.lastAccessedAt),
        classChangedAt: iso(obj.classChangedAt),
        hourly: hourly.map((h) => ({ t: iso(h.hour), reads: h.reads })),
      },
      current: current && {
        versionId: current.id,
        versionNo: current.versionNo,
        size: current.size,
        contentType: current.contentType,
        sha256: current.sha256,
        storageClass: current.storageClass,
        targetReplicas: current.targetReplicas,
        createdAt: iso(current.createdAt),
        integrity,
      },
      replicas: replicaDtos,
      versions: versionRows.map(({ v, createdByEmail }) => ({
        versionId: v.id,
        versionNo: v.versionNo,
        size: v.size,
        sha256: v.sha256,
        state: v.state,
        isDeleteMarker: v.isDeleteMarker,
        isCurrent: v.id === obj.currentVersionId,
        isProtected: v.isProtected,
        createdAt: iso(v.createdAt),
        deletedAt: iso(v.deletedAt),
        purgeAfter: iso(v.purgeAfter),
        createdBy: createdByEmail,
      })),
    };
  });
}

// =============================================================================================
// Upload: two-phase, streaming, constant memory
// =============================================================================================
function registerUpload(app: FastifyInstance, ctx: AppContext) {
  // The upload route gets its own encapsulated context so the raw body is never parsed:
  // *every* content type (including application/json) must reach us as an untouched stream.
  app.register(async (up) => {
    up.removeAllContentTypeParsers();
    up.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    up.addHook('onRequest', async (req) => {
      if (!req.headers['content-type']) req.headers['content-type'] = 'application/octet-stream';
    });

    up.put<{ Params: { bucket: string }; Querystring: Q }>(
      '/api/buckets/:bucket/object',
      { bodyLimit: ctx.cfg.MAX_UPLOAD_BYTES + 1024 },
      async (req, reply) => {
        const result = await uploadObject(ctx, req);
        return reply.code(201).send(result);
      },
    );
  });
}

async function uploadObject(ctx: AppContext, req: FastifyRequest<{ Params: { bucket: string }; Querystring: Q }>) {
  const principal = requireUser(req);
  const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'WRITE');
  const key = keyFrom(req.query);

  const declared = Number(req.headers['content-length']);
  const expectedSize = Number.isFinite(declared) ? declared : undefined;
  if (expectedSize !== undefined && expectedSize > ctx.cfg.MAX_UPLOAD_BYTES) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Single uploads are limited to ${ctx.cfg.MAX_UPLOAD_BYTES} bytes`);
  }
  const contentType = String(req.headers['content-type'] ?? 'application/octet-stream').slice(0, 255);
  const wanted = bucket.defaultReplicas;
  const versionId = randomUUID();
  const blobId = randomUUID();

  const placementKey = `${bucket.id}/${key}@${versionId}`;
  const nodes = await pickNodes(ctx.db, placementKey, {
    replicas: wanted,
    vnodes: ctx.cfg.VNODES_PER_NODE,
    offlineAfterMs: ctx.cfg.OFFLINE_AFTER_MS,
    expectedSize,
  });
  if (nodes.length < wanted) {
    throw new AppError(
      503,
      'INSUFFICIENT_HEALTHY_NODES',
      `Need ${wanted} healthy storage nodes but only ${nodes.length} available. Upload rejected to protect durability.`,
    );
  }

  // 1. record intent (PENDING) so a crash leaves a cleanable trail, never a half-visible object
  const blobPath = `blobs/${blobId.slice(0, 2)}/${blobId}`;
  const { objectId, versionNo } = await ctx.db.transaction(async (tx) => {
    const [obj] = await tx
      .insert(objects)
      .values({ bucketId: bucket.id, key })
      .onConflictDoUpdate({ target: [objects.bucketId, objects.key], set: { updatedAt: new Date() } }) // row lock serialises concurrent writers
      .returning({ id: objects.id });
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`coalesce(max(${objectVersions.versionNo}), 0)::int` })
      .from(objectVersions)
      .where(eq(objectVersions.objectId, obj!.id));
    await tx.insert(objectVersions).values({
      id: versionId,
      objectId: obj!.id,
      versionNo: n + 1,
      contentType,
      blobId,
      state: 'PENDING',
      targetReplicas: wanted,
      createdBy: principal.user.id,
    });
    await tx.insert(replicas).values(nodes.map((node) => ({ versionId, nodeId: node.id, blobPath, state: 'PENDING' as const })));
    return { objectId: obj!.id, versionNo: n + 1 };
  });

  const discard = async () => {
    await ctx.db.delete(objectVersions).where(eq(objectVersions.id, versionId)).catch(() => undefined);
  };

  // 2. stream to every replica node while hashing once. A node that fails mid-stream is dropped;
  //    the upload carries on as long as one copy is still being written.
  const sinks = nodes.map((n) => ctx.storage.startStage(n, blobId, { requestId: req.id, expectedSize }));
  let stats: Awaited<ReturnType<typeof fanoutStage>>;
  try {
    stats = await fanoutStage(req.raw, sinks, { maxBytes: ctx.cfg.MAX_UPLOAD_BYTES, minSinks: 1 });
  } catch (err) {
    await discard();
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'UPLOAD_FAILED', `Upload failed while streaming to storage nodes: ${(err as Error).message}`);
  }

  // 3. every surviving node must report exactly the bytes we sent
  const settled = await Promise.allSettled(sinks.map((s) => s.result));
  const good: { node: NodeRow; staged: StagedResult }[] = [];
  const lost: { node: NodeRow; reason: string }[] = [];
  const mismatched: string[] = [];
  for (const [i, s] of settled.entries()) {
    const node = nodes[i]!;
    const dropped = stats.failed.find((f) => f.sink === sinks[i]);
    if (dropped || s.status === 'rejected') {
      lost.push({ node, reason: (dropped?.error ?? (s as PromiseRejectedResult).reason as Error).message });
    } else if (s.value.sha256 !== stats.sha256 || s.value.size !== stats.size) {
      mismatched.push(node.name);
      lost.push({ node, reason: 'checksum mismatch' });
      await ctx.storage.abort(node, blobId, s.value.stagedToken);
    } else good.push({ node, staged: s.value });
  }
  if (mismatched.length) {
    await audit(ctx, req, { action: 'object.upload_checksum_mismatch', resourceType: 'object', resourceId: objectId, metadata: { bucket: bucket.name, key, nodes: mismatched } });
  }

  // 4. commit on the good nodes (atomic rename)
  const holders: { node: NodeRow; path: string; fallbackFor?: string }[] = [];
  const committed = await Promise.allSettled(good.map((g) => ctx.storage.commit(g.node, blobId, g.staged.stagedToken, req.id)));
  for (const [i, c] of committed.entries()) {
    const g = good[i]!;
    if (c.status === 'fulfilled') holders.push({ node: g.node, path: c.value.path });
    else {
      lost.push({ node: g.node, reason: `commit failed: ${(c.reason as Error).message}` });
      await ctx.storage.abort(g.node, blobId, g.staged.stagedToken);
    }
  }
  const rollback = async () => {
    await Promise.allSettled(holders.map((h) => ctx.storage.deleteBlob(h.node, blobId)));
    await discard();
  };
  if (!holders.length) {
    await discard();
    if (mismatched.length) throw new AppError(502, 'CHECKSUM_MISMATCH', `Checksum mismatch on ${mismatched.join(', ')}; nothing was stored. Please retry.`);
    throw new AppError(502, 'UPLOAD_FAILED', `Storage node error: ${lost.map((l) => `${l.node.name}: ${l.reason}`).join('; ')}`);
  }

  // 4b. replace lost copies: the next eligible node clockwise on the ring receives a verified copy
  //     of a committed replica (node -> API -> node, hashed in flight), so the upload still ends
  //     with R verified replicas instead of failing.
  const tried = new Set(nodes.map((n) => n.id));
  for (const l of lost) {
    if (holders.length >= wanted) break;
    let replaced = false;
    while (!replaced) {
      const [next] = await pickNodes(ctx.db, placementKey, {
        replicas: 1,
        vnodes: ctx.cfg.VNODES_PER_NODE,
        offlineAfterMs: ctx.cfg.OFFLINE_AFTER_MS,
        expectedSize: stats.size,
        exclude: tried,
      });
      if (!next) break;
      tried.add(next.id);
      await ctx.db.insert(replicas).values({ versionId, nodeId: next.id, blobPath, state: 'PENDING' }).onConflictDoNothing();
      try {
        const c = await ctx.storage.copyBlob(holders[0]!.node, next, blobId, { sha256: stats.sha256, size: stats.size }, req.id);
        holders.push({ node: next, path: c.path, fallbackFor: l.node.name });
        replaced = true;
        req.log.warn({ failed: l.node.name, replacement: next.name, reason: l.reason }, 'upload fell back to the next ring node');
      } catch (err) {
        req.log.warn({ node: next.name, err: (err as Error).message }, 'fallback copy failed; trying the next node');
      }
    }
  }
  if (holders.length < wanted) {
    await rollback();
    throw new AppError(
      502,
      'UPLOAD_FAILED',
      `Only ${holders.length} of ${wanted} copies could be stored (${lost.map((l) => `${l.node.name}: ${l.reason}`).join('; ')}); nothing was kept. Please retry.`,
    );
  }

  // 5. make it visible atomically
  const holderIds = holders.map((h) => h.node.id);
  const retention = new Date(Date.now() + ctx.cfg.RETENTION_HOURS * 3_600_000);
  const finalized = await ctx.db.transaction(async (tx) => {
    // Only a still-PENDING version may be activated. If the GC already reaped it (an upload that
    // took longer than the abandoned-upload timeout) we must not point the object at a ghost row.
    const activated = await tx
      .update(objectVersions)
      .set({ state: 'ACTIVE', size: stats.size, sha256: stats.sha256 })
      .where(and(eq(objectVersions.id, versionId), eq(objectVersions.state, 'PENDING')))
      .returning({ id: objectVersions.id });
    if (activated.length === 0) return false;
    await tx
      .update(replicas)
      .set({ state: 'HEALTHY', sha256: stats.sha256, lastVerifiedAt: new Date() })
      .where(and(eq(replicas.versionId, versionId), inArray(replicas.nodeId, holderIds)));
    await tx.delete(replicas).where(and(eq(replicas.versionId, versionId), notInArray(replicas.nodeId, holderIds)));
    const [locked] = await tx.select().from(objects).where(eq(objects.id, objectId)).for('update');
    if (locked?.currentVersionId && !bucket.versioningEnabled) {
      // overwrite without versioning: the old bytes stay recoverable until the retention purge
      await tx
        .update(objectVersions)
        .set({ state: 'DELETED', deletedAt: new Date(), purgeAfter: retention })
        .where(eq(objectVersions.id, locked.currentVersionId));
    }
    await tx.update(objects).set({ currentVersionId: versionId, updatedAt: new Date() }).where(eq(objects.id, objectId));
    return true;
  });
  if (!finalized) {
    await Promise.allSettled(holders.map((h) => ctx.storage.deleteBlob(h.node, blobId)));
    throw new AppError(502, 'UPLOAD_FAILED', 'Upload took too long and was cleaned up as abandoned; please retry.');
  }
  const fallback = holders.filter((h) => h.fallbackFor).map((h) => ({ failed: h.fallbackFor, replacement: h.node.name }));

  await audit(ctx, req, {
    action: 'object.upload',
    resourceType: 'object',
    resourceId: objectId,
    metadata: { bucket: bucket.name, key, size: stats.size, sha256: stats.sha256, versionNo, nodes: holders.map((h) => h.node.name), ...(fallback.length && { fallback }) },
  });
  void publishEvent(ctx.redis, 'object.created', { bucket: bucket.name, key, size: stats.size });

  return {
    key,
    versionId,
    versionNo,
    size: stats.size,
    sha256: stats.sha256,
    contentType,
    replicas: holders.map((h) => ({ node: h.node.name, path: h.path, ...(h.fallbackFor && { fallbackFor: h.fallbackFor }) })),
  };
}

// =============================================================================================
// Download with verification and replica fallback
// =============================================================================================
const STATUS_RANK: Record<string, number> = { HEALTHY: 0, WARNING: 1, HIGH_RISK: 2, DRAINING: 3, OFFLINE: 4 };

/** downloads currently held in memory for verify-before-send (capped to bound API memory) */
let bufferedInFlight = 0;
/** reads currently being served per node, for least-loaded replica selection */
const inFlight = new Map<string, number>();
const track = (nodeId: string, d: 1 | -1) => inFlight.set(nodeId, Math.max(0, (inFlight.get(nodeId) ?? 0) + d));

/** Count a read for HOT / WARM / COLD classification (hourly buckets; never blocks the download). */
function recordAccess(ctx: AppContext, objectId: string, size: number) {
  void ctx.db
    .execute(sql`
      WITH a AS (
        INSERT INTO object_access (object_id, hour, reads, bytes) VALUES (${objectId}, date_trunc('hour', now()), 1, ${size})
        ON CONFLICT (object_id, hour) DO UPDATE SET reads = object_access.reads + 1, bytes = object_access.bytes + excluded.bytes
      )
      UPDATE objects SET last_accessed_at = now() WHERE id = ${objectId}`)
    .catch((err: unknown) => ctx.log.warn({ err: String(err) }, 'access stats write failed'));
}

async function flagReplica(
  ctx: AppContext,
  req: FastifyRequest,
  replica: typeof replicas.$inferSelect,
  node: NodeRow,
  state: 'CORRUPT' | 'MISSING',
  detail: Record<string, unknown>,
) {
  await ctx.db.update(replicas).set({ state }).where(eq(replicas.id, replica.id)).catch(() => undefined);
  await audit(ctx, req, {
    action: state === 'CORRUPT' ? 'object.integrity_failure' : 'object.replica_missing',
    resourceType: 'replica',
    resourceId: replica.id,
    metadata: { node: node.name, versionId: replica.versionId, ...detail },
    actor: { type: 'SYSTEM', label: 'integrity-check' },
  });
  void publishEvent(ctx.redis, 'replica.flagged', { node: node.name, state, versionId: replica.versionId });
}

async function serveObject(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  bucket: BucketRow,
  key: string,
  version: typeof objectVersions.$inferSelect,
) {
  const candidates = await ctx.db
    .select({ r: replicas, node: storageNodes })
    .from(replicas)
    .innerJoin(storageNodes, eq(storageNodes.id, replicas.nodeId))
    .where(and(eq(replicas.versionId, version.id), eq(replicas.state, 'HEALTHY')));

  // Healthiest nodes first; shuffle within a tier so reads spread across equally good replicas.
  // Replicas on OFFLINE-marked nodes are kept as a last resort: the status may be stale (e.g. the
  // worker is lagging) and trying costs nothing when every better option has already failed.
  // Within a tier, prefer the least-loaded node (reads in flight here, then its recent latency),
  // with a little jitter so equal nodes share the load. This is what makes HOT objects' extra
  // replica useful: their reads spread across three nodes.
  const load = (n: NodeRow) => (inFlight.get(n.id) ?? 0) + (n.lastMetrics?.latencyMsP95 ?? 0) / 50;
  const ordered = candidates
    .map((c) => ({ ...c, jitter: Math.random() * 0.5 }))
    .sort((a, b) => (STATUS_RANK[a.node.status]! - STATUS_RANK[b.node.status]!) || load(a.node) + a.jitter - (load(b.node) + b.jitter));

  const expected = version.sha256!;
  const attempts: string[] = [];

  for (const { r, node } of ordered) {
    let blob;
    try {
      blob = await ctx.storage.openBlob(node, version.blobId!, req.id);
    } catch (err) {
      attempts.push(`${node.name}: ${(err as Error).message}`);
      continue; // unreachable -> try the next replica
    }
    if (blob.status === 404) {
      await flagReplica(ctx, req, r, node, 'MISSING', { expected });
      attempts.push(`${node.name}: blob missing`);
      continue;
    }
    if (!blob.stream) {
      attempts.push(`${node.name}: HTTP ${blob.status}`);
      continue;
    }

    objectHeaders(reply, version, key);
    reply.header('x-aegis-served-by', node.name);

    // Small objects are fully verified BEFORE the first byte is sent, so a corrupt replica
    // is never exposed to the client and we can transparently fall back.
    const buffered = version.size <= ctx.cfg.VERIFY_BUFFER_MAX_BYTES && bufferedInFlight < ctx.cfg.VERIFY_BUFFER_CONCURRENCY;
    if (buffered) {
      bufferedInFlight++;
      track(node.id, 1);
      try {
        const chunks: Buffer[] = [];
        for await (const c of blob.stream) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        const actual = sha256Of(body);
        if (actual !== expected || body.length !== version.size) {
          await flagReplica(ctx, req, r, node, 'CORRUPT', { expected, actual });
          attempts.push(`${node.name}: checksum mismatch`);
          reply.removeHeader('x-aegis-served-by');
          continue;
        }
        await audit(ctx, req, { action: 'object.download', resourceType: 'object', resourceId: version.objectId, metadata: { bucket: bucket.name, key, size: version.size, versionId: version.id, servedBy: node.name, fallbacks: attempts.length } });
        recordAccess(ctx, version.objectId, version.size);
        return reply.header('x-aegis-integrity', 'verified').send(body);
      } catch (err) {
        attempts.push(`${node.name}: ${(err as Error).message}`);
        continue;
      } finally {
        bufferedInFlight--;
        track(node.id, -1);
      }
    }

    // Large objects (or small ones while the buffer budget is used up) stream through a verifier; on a final mismatch the response is aborted
    // (the client sees a truncated transfer and the checksum is never reported as verified).
    const hash = createHash('sha256');
    const verifier = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
      flush(cb) {
        const actual = hash.digest('hex');
        if (actual === expected) return cb();
        void flagReplica(ctx, req, r, node, 'CORRUPT', { expected, actual });
        cb(new Error('checksum mismatch'));
      },
    });
    await audit(ctx, req, { action: 'object.download', resourceType: 'object', resourceId: version.objectId, metadata: { bucket: bucket.name, key, size: version.size, versionId: version.id, servedBy: node.name, streamed: true } });
    recordAccess(ctx, version.objectId, version.size);
    track(node.id, 1);
    reply.raw.once('close', () => track(node.id, -1));
    return reply.header('x-aegis-integrity', 'streaming').send(pipeline(blob.stream, verifier, () => undefined));
  }

  req.log.warn({ attempts }, 'no healthy replica could serve the object');
  throw new AppError(503, 'STORAGE_UNAVAILABLE', 'No healthy replica is currently available for this object', { attempts });
}
