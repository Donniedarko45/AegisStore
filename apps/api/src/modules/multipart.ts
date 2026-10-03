import { randomUUID } from 'node:crypto';
import { and, eq, inArray, multipartParts, multipartUploads, sql, storageNodes } from '@aegis/db';
import { AppError } from '@aegis/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { requireBucket, type BucketRow } from '../core/access';
import { audit } from '../core/audit';
import { fanoutStage } from '../core/fanout';
import { iso, parse } from '../core/http';
import type { NodeRow } from '../core/placement';
import { requireUser } from '../plugins/auth';
import { assertWritable, beginVersion, discardVersion, finishVersion, keyFrom, placeVersion, type Holder } from './objects';

const MAX_PARTS = 10_000;
const initSchema = z.object({
  contentType: z.string().max(255).optional(),
  /** total size if known: checked against the object limit and used to suggest a part size */
  size: z.number().int().nonnegative().optional(),
});
const completeSchema = z.object({
  parts: z.array(z.object({ partNo: z.number().int().min(1).max(MAX_PARTS), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).optional(),
});

type Upload = typeof multipartUploads.$inferSelect;

async function loadUpload(ctx: AppContext, req: FastifyRequest, bucket: BucketRow, uploadId: string): Promise<Upload> {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw AppError.notFound('Upload not found');
  const [up] = await ctx.db
    .select()
    .from(multipartUploads)
    .where(and(eq(multipartUploads.id, uploadId), eq(multipartUploads.bucketId, bucket.id)));
  if (!up) throw AppError.notFound('Upload not found');
  const p = req.principal!;
  // an upload in progress belongs to whoever started it (or a bucket/site admin)
  if (up.createdBy !== p.user.id && p.user.role !== 'ADMIN' && bucket.ownerId !== p.user.id) throw AppError.notFound('Upload not found');
  return up;
}

/** The upload's nodes that are reachable right now. */
async function liveNodes(ctx: AppContext, ids: string[]): Promise<NodeRow[]> {
  if (!ids.length) return [];
  const rows = await ctx.db
    .select({ node: storageNodes, fresh: sql<boolean>`coalesce(${storageNodes.lastHeartbeatAt} > now() - make_interval(secs => ${ctx.cfg.OFFLINE_AFTER_MS / 1000}), false)` })
    .from(storageNodes)
    .where(inArray(storageNodes.id, ids));
  return rows.filter((r) => r.fresh && r.node.status !== 'OFFLINE').map((r) => r.node);
}

const partSizeFor = (ctx: AppContext, size?: number) => {
  const min = ctx.cfg.MULTIPART_MIN_PART_BYTES;
  const want = size ? Math.ceil(size / MAX_PARTS) : 0;
  return Math.min(ctx.cfg.MULTIPART_MAX_PART_BYTES, Math.max(min, 16 * 1024 * 1024, want));
};

/**
 * Multipart upload (architecture §6.7) for objects above the single-request limit.
 *
 * Every part streams to the R nodes chosen on the ring when the upload starts (hashed in flight,
 * resumable: a part can be re-sent). `complete` makes each node concatenate its parts into one
 * blob while hashing; the nodes must agree on the result. The object then has a real whole-file
 * SHA-256 (it matches `sha256sum`), and repair, purge and download treat it like any other blob.
 */
export function multipartRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post<{ Params: { bucket: string }; Querystring: { key?: string } }>('/api/buckets/:bucket/multipart', async (req, reply) => {
    const p = requireUser(req);
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'WRITE');
    const key = keyFrom(req.query);
    const body = parse(initSchema, req.body ?? {});
    if (body.size !== undefined && body.size > ctx.cfg.MAX_OBJECT_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Objects are limited to ${ctx.cfg.MAX_OBJECT_BYTES} bytes`);
    }
    await assertWritable(ctx, bucket, key);
    const placed = await placeVersion(ctx, bucket, key, body.size);
    const [up] = await ctx.db
      .insert(multipartUploads)
      .values({
        bucketId: bucket.id,
        key,
        contentType: (body.contentType || 'application/octet-stream').slice(0, 255),
        createdBy: p.user.id,
        nodeIds: placed.nodes.map((n) => n.id),
        expiresAt: new Date(Date.now() + ctx.cfg.MULTIPART_EXPIRY_HOURS * 3_600_000),
      })
      .returning();
    await audit(ctx, req, { action: 'multipart.start', resourceType: 'multipart', resourceId: up!.id, metadata: { bucket: bucket.name, key, size: body.size ?? null } });
    return reply.code(201).send({
      uploadId: up!.id,
      key,
      nodes: placed.nodes.map((n) => n.name),
      partSize: partSizeFor(ctx, body.size),
      minPartSize: ctx.cfg.MULTIPART_MIN_PART_BYTES,
      maxPartSize: ctx.cfg.MULTIPART_MAX_PART_BYTES,
      maxParts: MAX_PARTS,
      expiresAt: iso(up!.expiresAt),
    });
  });

  app.get<{ Params: { bucket: string } }>('/api/buckets/:bucket/multipart', async (req) => {
    const p = requireUser(req);
    const { bucket, access } = await requireBucket(ctx, req, req.params.bucket, 'WRITE');
    const rows = await ctx.db
      .select({
        up: multipartUploads,
        parts: sql<number>`(SELECT count(*)::int FROM multipart_parts mp WHERE mp.upload_id = ${multipartUploads.id})`,
        bytes: sql<number>`(SELECT coalesce(sum(size), 0)::bigint FROM multipart_parts mp WHERE mp.upload_id = ${multipartUploads.id})`,
      })
      .from(multipartUploads)
      .where(and(eq(multipartUploads.bucketId, bucket.id), eq(multipartUploads.state, 'ACTIVE')));
    return {
      items: rows
        .filter((r) => access.level === 'ADMIN' || r.up.createdBy === p.user.id)
        .map((r) => ({ uploadId: r.up.id, key: r.up.key, parts: r.parts, bytes: Number(r.bytes), createdAt: iso(r.up.createdAt), expiresAt: iso(r.up.expiresAt) })),
    };
  });

  app.get<{ Params: { bucket: string; uploadId: string } }>('/api/buckets/:bucket/multipart/:uploadId', async (req) => {
    requireUser(req);
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'WRITE');
    const up = await loadUpload(ctx, req, bucket, req.params.uploadId);
    const parts = await ctx.db.select().from(multipartParts).where(eq(multipartParts.uploadId, up.id)).orderBy(multipartParts.partNo);
    return {
      uploadId: up.id,
      key: up.key,
      state: up.state,
      expiresAt: iso(up.expiresAt),
      parts: parts.map((x) => ({ partNo: x.partNo, size: x.size, sha256: x.sha256, copies: x.nodeIds.length })),
    };
  });

  // Parts arrive as raw streams, so this route gets its own encapsulated context (no body parsing).
  app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    raw.put<{ Params: { bucket: string; uploadId: string; partNo: string } }>(
      '/api/buckets/:bucket/multipart/:uploadId/parts/:partNo',
      { bodyLimit: ctx.cfg.MULTIPART_MAX_PART_BYTES + 1024 },
      async (req) => {
        requireUser(req);
        const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'WRITE');
        const up = await loadUpload(ctx, req, bucket, req.params.uploadId);
        if (up.state !== 'ACTIVE') throw AppError.conflict(`Upload is ${up.state.toLowerCase()}`);
        const partNo = Number(req.params.partNo);
        if (!Number.isInteger(partNo) || partNo < 1 || partNo > MAX_PARTS) throw AppError.validation(`partNo must be 1-${MAX_PARTS}`);
        const declared = Number(req.headers['content-length']);
        const expectedSize = Number.isFinite(declared) ? declared : undefined;
        if (expectedSize !== undefined && expectedSize > ctx.cfg.MULTIPART_MAX_PART_BYTES) {
          throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Parts are limited to ${ctx.cfg.MULTIPART_MAX_PART_BYTES} bytes`);
        }
        const nodes = await liveNodes(ctx, up.nodeIds);
        if (!nodes.length) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'None of this upload\'s storage nodes is reachable; retry later or start a new upload');

        const sinks = nodes.map((n) => ctx.storage.startPart(n, up.id, partNo, { requestId: req.id, expectedSize }));
        const stats = await fanoutStage(req.raw, sinks, { maxBytes: ctx.cfg.MULTIPART_MAX_PART_BYTES, minSinks: 1 }).catch((err: unknown) => {
          if (err instanceof AppError) throw err;
          throw new AppError(502, 'UPLOAD_FAILED', `Part upload failed: ${(err as Error).message}`);
        });
        const settled = await Promise.allSettled(sinks.map((s) => s.result));
        const holders = nodes.filter((_, i) => {
          const s = settled[i]!;
          return s.status === 'fulfilled' && !stats.failed.some((f) => f.sink === sinks[i]) && s.value.sha256 === stats.sha256 && s.value.size === stats.size;
        });
        if (!holders.length) throw new AppError(502, 'UPLOAD_FAILED', 'No storage node accepted this part; please retry it');
        await ctx.db
          .insert(multipartParts)
          .values({ uploadId: up.id, partNo, size: stats.size, sha256: stats.sha256, nodeIds: holders.map((n) => n.id), entropy: partNo === 1 ? stats.entropy : null })
          .onConflictDoUpdate({
            target: [multipartParts.uploadId, multipartParts.partNo],
            set: { size: stats.size, sha256: stats.sha256, nodeIds: holders.map((n) => n.id), entropy: partNo === 1 ? stats.entropy : null, createdAt: new Date() },
          });
        return { partNo, size: stats.size, sha256: stats.sha256, copies: holders.length };
      },
    );
  });

  app.post<{ Params: { bucket: string; uploadId: string } }>('/api/buckets/:bucket/multipart/:uploadId/complete', async (req, reply) => {
    const p = requireUser(req);
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'WRITE');
    const up = await loadUpload(ctx, req, bucket, req.params.uploadId);
    if (up.state !== 'ACTIVE') throw AppError.conflict(`Upload is ${up.state.toLowerCase()}`);
    const body = parse(completeSchema, req.body ?? {});
    const parts = await ctx.db.select().from(multipartParts).where(eq(multipartParts.uploadId, up.id)).orderBy(multipartParts.partNo);
    if (!parts.length) throw AppError.validation('No parts were uploaded');
    // parts must be 1..N without gaps; every part but the last must meet the minimum size
    parts.forEach((x, i) => {
      if (x.partNo !== i + 1) throw AppError.validation(`Part ${i + 1} is missing`);
      if (i < parts.length - 1 && x.size < ctx.cfg.MULTIPART_MIN_PART_BYTES) {
        throw AppError.validation(`Part ${x.partNo} is ${x.size} bytes; every part except the last must be at least ${ctx.cfg.MULTIPART_MIN_PART_BYTES}`);
      }
    });
    if (body.parts) {
      const mismatch = body.parts.length !== parts.length || body.parts.some((c, i) => c.partNo !== parts[i]!.partNo || c.sha256 !== parts[i]!.sha256);
      if (mismatch) throw new AppError(409, 'CHECKSUM_MISMATCH', 'The part list does not match what the server received');
    }
    const size = parts.reduce((a, x) => a + x.size, 0);
    if (size > ctx.cfg.MAX_OBJECT_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Objects are limited to ${ctx.cfg.MAX_OBJECT_BYTES} bytes`);
    await assertWritable(ctx, bucket, up.key);

    // nodes that hold every part can build the object; the others are replaced afterwards
    const live = await liveNodes(ctx, up.nodeIds);
    const complete = live.filter((n) => parts.every((x) => x.nodeIds.includes(n.id)));
    if (!complete.length) {
      throw AppError.conflict('No reachable storage node holds every part; re-upload the parts and try again');
    }
    const versionId = randomUUID();
    const placed = { wanted: bucket.defaultReplicas, versionId, placementKey: `${bucket.id}/${up.key}@${versionId}`, nodes: complete };
    const pv = await beginVersion(ctx, p.user.id, bucket, up.key, up.contentType, placed);

    const partNos = parts.map((x) => x.partNo);
    const composed = await Promise.allSettled(complete.map((n) => ctx.storage.compose(n, up.id, pv.blobId, partNos, req.id)));
    // every node composed from parts it verified on arrival, so they must all agree
    const ok = composed.flatMap((c, i) => (c.status === 'fulfilled' && c.value.size === size ? [{ node: complete[i]!, ...c.value }] : []));
    const votes = new Map<string, number>();
    for (const o of ok) votes.set(o.sha256, (votes.get(o.sha256) ?? 0) + 1);
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || (ranked.length > 1 && ranked[0]![1] === ranked[1]![1])) {
      await Promise.allSettled(ok.map((o) => ctx.storage.deleteBlob(o.node, pv.blobId)));
      await discardVersion(ctx, pv);
      throw new AppError(502, 'UPLOAD_FAILED', 'The storage nodes could not agree on the assembled object; please retry the completion');
    }
    const sha256 = ranked[0]![0];
    const holders: Holder[] = ok.filter((o) => o.sha256 === sha256).map((o) => ({ node: o.node, path: o.path }));
    const lost: { node: { name: string }; reason: string }[] = [
      ...ok.filter((o) => o.sha256 !== sha256).map((o) => ({ node: o.node, reason: 'assembled checksum disagrees' })),
      ...composed.flatMap((c, i) => (c.status === 'rejected' ? [{ node: complete[i]!, reason: (c.reason as Error).message }] : [])),
    ];
    await Promise.allSettled(ok.filter((o) => o.sha256 !== sha256).map((o) => ctx.storage.deleteBlob(o.node, pv.blobId)));
    // upload nodes that were unreachable or missed parts also count as lost copies to replace
    const absent = up.nodeIds.filter((id) => !complete.some((n) => n.id === id));
    if (absent.length) {
      const names = await ctx.db.select({ name: storageNodes.name }).from(storageNodes).where(inArray(storageNodes.id, absent));
      for (const n of names) lost.push({ node: n, reason: 'unreachable or missing parts' });
    }

    const result = await finishVersion(ctx, req, pv, {
      holders,
      lost,
      sha256,
      size,
      entropy: parts[0]!.entropy,
      audit: { multipart: true, parts: parts.length },
    });
    await ctx.db.update(multipartUploads).set({ state: 'COMPLETED', versionId: result.versionId }).where(eq(multipartUploads.id, up.id));
    // nodes that could not take part keep their partial parts: remove them
    const others = await liveNodes(ctx, up.nodeIds.filter((id) => !complete.some((n) => n.id === id)));
    await Promise.allSettled(others.map((n) => ctx.storage.abortParts(n, up.id)));
    return reply.code(201).send({ ...result, parts: parts.length });
  });

  app.delete<{ Params: { bucket: string; uploadId: string } }>('/api/buckets/:bucket/multipart/:uploadId', async (req) => {
    requireUser(req);
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'WRITE');
    const up = await loadUpload(ctx, req, bucket, req.params.uploadId);
    if (up.state !== 'ACTIVE') return { ok: true, state: up.state };
    const nodes = await liveNodes(ctx, up.nodeIds);
    await Promise.allSettled(nodes.map((n) => ctx.storage.abortParts(n, up.id)));
    await ctx.db.update(multipartUploads).set({ state: 'ABORTED' }).where(eq(multipartUploads.id, up.id));
    await ctx.db.delete(multipartParts).where(eq(multipartParts.uploadId, up.id));
    await audit(ctx, req, { action: 'multipart.abort', resourceType: 'multipart', resourceId: up.id, metadata: { bucket: bucket.name, key: up.key } });
    return { ok: true, state: 'ABORTED' };
  });
}
