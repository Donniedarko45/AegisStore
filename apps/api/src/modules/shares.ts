import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, buckets, desc, eq, isNull, objectVersions, objects, shareLinks, sql, users } from '@aegis/db';
import { AppError } from '@aegis/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context';
import { requireBucket } from '../core/access';
import { audit } from '../core/audit';
import { iso, parse, rowsOf } from '../core/http';
import { requireUser } from '../plugins/auth';
import { findObject, keyFrom, serveObject } from './objects';

const createSchema = z.object({
  expiresInSec: z.number().int().min(60),
  maxDownloads: z.number().int().min(1).max(100_000).optional(),
  versionId: z.string().uuid().optional(),
});

/**
 * Signed share links (architecture §6.8): time-limited, login-free downloads.
 * Token = <link id>.<base64url HMAC-SHA256(secret, id.expiry)>. The HMAC makes tokens unforgeable;
 * the database row makes them revocable and lets a download cap be enforced atomically.
 * Rotating SIGNED_URL_SECRET invalidates every outstanding link at once.
 */
export function signToken(secret: string, id: string, expiresAt: Date): string {
  const mac = createHmac('sha256', secret).update(`${id}.${Math.floor(expiresAt.getTime() / 1000)}`).digest('base64url');
  return `${id}.${mac}`;
}

export function verifyToken(secret: string, token: string, expiresAt: Date): boolean {
  const [id, mac] = token.split('.');
  if (!id || !mac) return false;
  const expected = signToken(secret, id, expiresAt).split('.')[1]!;
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A small, self-contained page for a dead link (people open these in a browser). */
function gone(reply: FastifyReply, status: number, title: string, detail: string) {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · AegisStore</title>` +
        `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#fafafa;color:#171717}` +
        `@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#ededed}p{color:#a1a1a1}}main{max-width:420px;padding:24px;text-align:center}` +
        `h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#666}</style><main><h1>${esc(title)}</h1><p>${esc(detail)}</p></main>`,
    );
}

export function shareRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post<{ Params: { bucket: string }; Querystring: { key?: string } }>('/api/buckets/:bucket/object/share', async (req, reply) => {
    const p = requireUser(req);
    const { bucket } = await requireBucket(ctx, req, req.params.bucket, 'READ');
    const key = keyFrom(req.query);
    const body = parse(createSchema, req.body ?? {});
    if (body.expiresInSec > ctx.cfg.SIGNED_URL_MAX_TTL_SEC) {
      throw AppError.validation(`Links can live at most ${Math.round(ctx.cfg.SIGNED_URL_MAX_TTL_SEC / 3600)} hours`);
    }
    const obj = await findObject(ctx, bucket.id, key);
    const versionId = body.versionId ?? obj?.currentVersionId;
    if (!obj || !versionId) throw AppError.notFound('Object not found');
    const [v] = await ctx.db
      .select()
      .from(objectVersions)
      .where(and(eq(objectVersions.id, versionId), eq(objectVersions.objectId, obj.id)));
    if (!v || v.state !== 'ACTIVE' || v.isDeleteMarker) throw AppError.notFound('Version not found');

    const expiresAt = new Date(Date.now() + body.expiresInSec * 1000);
    const [link] = await ctx.db
      .insert(shareLinks)
      .values({ bucketId: bucket.id, objectId: obj.id, versionId: v.id, key, createdBy: p.user.id, expiresAt, maxDownloads: body.maxDownloads ?? null })
      .returning();
    const token = signToken(ctx.cfg.SIGNED_URL_SECRET, link!.id, expiresAt);
    await audit(ctx, req, {
      action: 'share.create',
      resourceType: 'share_link',
      resourceId: link!.id,
      metadata: { bucket: bucket.name, key, versionNo: v.versionNo, expiresAt: expiresAt.toISOString(), maxDownloads: body.maxDownloads ?? null },
    });
    return reply.code(201).send({ id: link!.id, url: `/s/${token}`, expiresAt: iso(expiresAt), maxDownloads: link!.maxDownloads, versionNo: v.versionNo });
  });

  app.get<{ Params: { bucket: string }; Querystring: { key?: string } }>('/api/buckets/:bucket/object/shares', async (req) => {
    const p = requireUser(req);
    const { bucket, access } = await requireBucket(ctx, req, req.params.bucket, 'READ');
    const key = keyFrom(req.query);
    const rows = await ctx.db
      .select({ l: shareLinks, by: users.email, versionNo: objectVersions.versionNo })
      .from(shareLinks)
      .leftJoin(users, eq(users.id, shareLinks.createdBy))
      .leftJoin(objectVersions, eq(objectVersions.id, shareLinks.versionId))
      .where(and(eq(shareLinks.bucketId, bucket.id), eq(shareLinks.key, key)))
      .orderBy(desc(shareLinks.createdAt))
      .limit(100);
    const now = Date.now();
    return {
      items: rows
        // bucket admins see every link; everyone else only their own
        .filter((r) => access.level === 'ADMIN' || r.l.createdBy === p.user.id)
        .map(({ l, by, versionNo }) => ({
          id: l.id,
          createdBy: by,
          versionNo,
          createdAt: iso(l.createdAt),
          expiresAt: iso(l.expiresAt),
          maxDownloads: l.maxDownloads,
          downloads: l.downloads,
          lastUsedAt: iso(l.lastUsedAt),
          revokedAt: iso(l.revokedAt),
          status: l.revokedAt ? 'REVOKED' : l.expiresAt.getTime() <= now ? 'EXPIRED' : l.maxDownloads !== null && l.downloads >= l.maxDownloads ? 'USED_UP' : 'ACTIVE',
        })),
    };
  });

  app.delete<{ Params: { id: string } }>('/api/shares/:id', async (req) => {
    const p = requireUser(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw AppError.notFound('Link not found');
    const [row] = await ctx.db
      .select({ l: shareLinks, bucket: buckets.name })
      .from(shareLinks)
      .innerJoin(buckets, eq(buckets.id, shareLinks.bucketId))
      .where(eq(shareLinks.id, req.params.id));
    if (!row) throw AppError.notFound('Link not found');
    if (row.l.createdBy !== p.user.id) await requireBucket(ctx, req, row.bucket, 'ADMIN');
    await ctx.db.update(shareLinks).set({ revokedAt: new Date() }).where(and(eq(shareLinks.id, row.l.id), isNull(shareLinks.revokedAt)));
    await audit(ctx, req, { action: 'share.revoke', resourceType: 'share_link', resourceId: row.l.id, metadata: { bucket: row.bucket, key: row.l.key } });
    return { ok: true };
  });

  // Public: the link itself is the credential.
  app.get<{ Params: { token: string } }>('/s/:token', { exposeHeadRoute: false }, async (req, reply) => {
    const token = req.params.token.slice(0, 200);
    const id = token.split('.')[0] ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return gone(reply, 404, 'Link not found', 'This share link is not valid.');
    const [row] = await ctx.db
      .select({ l: shareLinks, bucket: buckets })
      .from(shareLinks)
      .innerJoin(buckets, eq(buckets.id, shareLinks.bucketId))
      .where(eq(shareLinks.id, id));
    if (!row || !verifyToken(ctx.cfg.SIGNED_URL_SECRET, token, row.l.expiresAt)) return gone(reply, 404, 'Link not found', 'This share link is not valid.');
    if (row.bucket.deletedAt) return gone(reply, 410, 'No longer available', 'The bucket this file was shared from has been deleted.');

    // one atomic statement enforces revocation, expiry and the download cap, even under concurrency
    const [claimed] = rowsOf<{ downloads: number }>(
      await ctx.db.execute(sql`
        UPDATE share_links SET downloads = downloads + 1, last_used_at = now()
         WHERE id = ${id} AND revoked_at IS NULL AND expires_at > now() AND (max_downloads IS NULL OR downloads < max_downloads)
        RETURNING downloads`),
    );
    if (!claimed) {
      const why = row.l.revokedAt ? 'It was revoked by its owner.' : row.l.expiresAt.getTime() <= Date.now() ? 'It has expired.' : 'It reached its download limit.';
      return gone(reply, 410, 'This link is no longer active', why);
    }
    const [v] = await ctx.db.select().from(objectVersions).where(eq(objectVersions.id, row.l.versionId));
    const [obj] = await ctx.db.select().from(objects).where(eq(objects.id, row.l.objectId));
    if (!v || !obj || v.state !== 'ACTIVE' || v.isDeleteMarker) return gone(reply, 410, 'No longer available', 'The shared version of this file has been deleted.');
    return serveObject(ctx, req, reply, row.bucket, row.l.key, v, {
      actor: { id: row.l.createdBy, type: 'SIGNED_URL', label: `share link ${id.slice(0, 8)}` },
    });
  });
}
