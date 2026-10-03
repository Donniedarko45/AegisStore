import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream';
import { and, desc, eq, inArray, objectVersions, objects, replicas, sql, storageNodes, users } from '@aegis/db';
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
import { pickNodes, type NodeRow } from '../core/placement';
import { publishEvent } from '../core/redis';
import type { StagedResult } from '../core/storageclient';
import { requireUser } from '../plugins/auth';

type Q = { key?: string; versionId?: string };

export const integrityOf = (available: number, target: number): IntegrityStatus =>
  available >= target ? 'HEALTHY' : available === 0 ? 'UNAVAILABLE' : 'DEGRADED';

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
      ) t
      WHERE (${q.integrity ?? null}::text IS NULL OR
             (CASE WHEN t.available >= t.target_replicas THEN 'HEALTHY'
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
        ) t
        WHERE (${q.integrity ?? null}::text IS NULL OR
               (CASE WHEN t.available >= t.target_replicas THEN 'HEALTHY'
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
      integrity: integrityOf(r.available, r.target_replicas),
      availableReplicas: r.available,
      targetReplicas: r.target_replicas,
      createdAt: iso(r.created_at)!,
    }));
    return { items, total, page: q.page, pageSize: q.pageSize };
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
      integrity = integrityOf(available, current.targetReplicas);
    }

    return {
      key,
      bucket: bucket.name,
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

  const nodes = await pickNodes(ctx.db, `${bucket.id}/${key}@${versionId}`, {
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

  // 2. stream to every replica node while hashing once
  const sinks = nodes.map((n) => ctx.storage.startStage(n, blobId, { requestId: req.id, expectedSize }));
  let stats: { sha256: string; size: number };
  try {
    stats = await fanoutStage(req.raw, sinks, { maxBytes: ctx.cfg.MAX_UPLOAD_BYTES });
  } catch (err) {
    await discard();
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'UPLOAD_FAILED', `Upload failed while streaming to storage nodes: ${(err as Error).message}`);
  }

  // 3. every node must report exactly the bytes we sent
  const settled = await Promise.allSettled(sinks.map((s) => s.result));
  const staged = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
  const abortStaged = () =>
    Promise.allSettled(staged.map((s, i) => (s ? ctx.storage.abort(nodes[i]!, blobId, s.stagedToken) : undefined)));

  const failed = settled.flatMap((s, i) => (s.status === 'rejected' ? [`${nodes[i]!.name}: ${(s.reason as Error).message}`] : []));
  if (failed.length) {
    await abortStaged();
    await discard();
    throw new AppError(502, 'UPLOAD_FAILED', `Storage node error: ${failed.join('; ')}`);
  }
  const mismatched = staged.flatMap((s, i) => (s && (s.sha256 !== stats.sha256 || s.size !== stats.size) ? [nodes[i]!.name] : []));
  if (mismatched.length) {
    await abortStaged();
    await discard();
    await audit(ctx, req, { action: 'object.upload_checksum_mismatch', resourceType: 'object', resourceId: objectId, metadata: { bucket: bucket.name, key, nodes: mismatched } });
    throw new AppError(502, 'CHECKSUM_MISMATCH', `Checksum mismatch on ${mismatched.join(', ')}; nothing was stored. Please retry.`);
  }

  // 4. commit on every node (atomic rename); all-or-nothing
  const committed = await Promise.allSettled(nodes.map((n, i) => ctx.storage.commit(n, blobId, (staged[i] as StagedResult).stagedToken, req.id)));
  const commitFailures = committed.flatMap((c, i) => (c.status === 'rejected' ? [i] : []));
  if (commitFailures.length) {
    await Promise.allSettled(
      nodes.map((n, i) => (commitFailures.includes(i) ? ctx.storage.abort(n, blobId, (staged[i] as StagedResult).stagedToken) : ctx.storage.deleteBlob(n, blobId))),
    );
    await discard();
    throw new AppError(502, 'UPLOAD_FAILED', `Commit failed on ${commitFailures.map((i) => nodes[i]!.name).join(', ')}; nothing was stored.`);
  }

  // 5. make it visible atomically
  const retention = new Date(Date.now() + ctx.cfg.RETENTION_HOURS * 3_600_000);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(replicas)
      .set({ state: 'HEALTHY', sha256: stats.sha256, lastVerifiedAt: new Date() })
      .where(and(eq(replicas.versionId, versionId), inArray(replicas.nodeId, nodes.map((n) => n.id))));
    await tx.update(objectVersions).set({ state: 'ACTIVE', size: stats.size, sha256: stats.sha256 }).where(eq(objectVersions.id, versionId));
    const [locked] = await tx.select().from(objects).where(eq(objects.id, objectId)).for('update');
    if (locked?.currentVersionId && !bucket.versioningEnabled) {
      // overwrite without versioning: the old bytes stay recoverable until the retention purge
      await tx
        .update(objectVersions)
        .set({ state: 'DELETED', deletedAt: new Date(), purgeAfter: retention })
        .where(eq(objectVersions.id, locked.currentVersionId));
    }
    await tx.update(objects).set({ currentVersionId: versionId, updatedAt: new Date() }).where(eq(objects.id, objectId));
  });

  await audit(ctx, req, {
    action: 'object.upload',
    resourceType: 'object',
    resourceId: objectId,
    metadata: { bucket: bucket.name, key, size: stats.size, sha256: stats.sha256, versionNo, nodes: nodes.map((n) => n.name) },
  });
  void publishEvent(ctx.redis, 'object.created', { bucket: bucket.name, key, size: stats.size });

  return {
    key,
    versionId,
    versionNo,
    size: stats.size,
    sha256: stats.sha256,
    contentType,
    replicas: nodes.map((n, i) => ({ node: n.name, path: (committed[i] as PromiseFulfilledResult<{ path: string }>).value.path })),
  };
}

// =============================================================================================
// Download with verification and replica fallback
// =============================================================================================
const STATUS_RANK: Record<string, number> = { HEALTHY: 0, WARNING: 1, HIGH_RISK: 2, DRAINING: 3, OFFLINE: 4 };

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

  // healthiest nodes first; shuffle within a tier so reads spread across equally good replicas
  const ordered = candidates
    .filter((c) => c.node.status !== 'OFFLINE')
    .map((c) => ({ ...c, jitter: Math.random() }))
    .sort((a, b) => (STATUS_RANK[a.node.status]! - STATUS_RANK[b.node.status]!) || a.jitter - b.jitter);

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
    if (version.size <= ctx.cfg.VERIFY_BUFFER_MAX_BYTES) {
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
        await audit(ctx, req, { action: 'object.download', resourceType: 'object', resourceId: version.objectId, metadata: { bucket: bucket.name, key, versionId: version.id, servedBy: node.name, fallbacks: attempts.length } });
        return reply.header('x-aegis-integrity', 'verified').send(body);
      } catch (err) {
        attempts.push(`${node.name}: ${(err as Error).message}`);
        continue;
      }
    }

    // Large objects stream through a verifier; on a final mismatch the response is aborted
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
    await audit(ctx, req, { action: 'object.download', resourceType: 'object', resourceId: version.objectId, metadata: { bucket: bucket.name, key, versionId: version.id, servedBy: node.name, streamed: true } });
    return reply.header('x-aegis-integrity', 'streaming').send(pipeline(blob.stream, verifier, () => undefined));
  }

  req.log.warn({ attempts }, 'no healthy replica could serve the object');
  throw new AppError(503, 'STORAGE_UNAVAILABLE', 'No healthy replica is currently available for this object', { attempts });
}
