import { eq, sessions, sql, users } from '@aegis/db';
import { AppError, USER_ROLES } from '@aegis/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { audit } from '../core/audit';
import { iso, parse, rowsOf } from '../core/http';
import { requireSiteAdmin } from '../plugins/auth';

const patchSchema = z
  .object({ role: z.enum(USER_ROLES).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional() })
  .refine((v) => v.role !== undefined || v.status !== undefined, 'Nothing to change');

export function userRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/users', async (req) => {
    requireSiteAdmin(req);
    const rows = rowsOf<{
      id: string; email: string; name: string | null; role: 'ADMIN' | 'MEMBER'; status: string; created_at: Date; last_login_at: Date | null;
      buckets: number; objects: number; bytes: number; api_keys: number; sessions: number;
    }>(
      await ctx.db.execute(sql`
        SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at,
               (SELECT count(*) FROM buckets b WHERE b.owner_id = u.id AND b.deleted_at IS NULL)::int AS buckets,
               (SELECT count(*) FROM objects o JOIN buckets b ON b.id = o.bucket_id JOIN object_versions v ON v.id = o.current_version_id
                 WHERE b.owner_id = u.id AND b.deleted_at IS NULL AND v.state = 'ACTIVE')::int AS objects,
               (SELECT coalesce(sum(v.size), 0) FROM objects o JOIN buckets b ON b.id = o.bucket_id JOIN object_versions v ON v.id = o.current_version_id
                 WHERE b.owner_id = u.id AND b.deleted_at IS NULL AND v.state = 'ACTIVE')::bigint AS bytes,
               (SELECT count(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL)::int AS api_keys,
               (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now())::int AS sessions
          FROM users u ORDER BY u.created_at`),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        status: r.status,
        createdAt: iso(r.created_at),
        lastLoginAt: iso(r.last_login_at),
        buckets: r.buckets,
        objects: r.objects,
        bytes: Number(r.bytes),
        apiKeys: r.api_keys,
        sessions: r.sessions,
      })),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const admin = requireSiteAdmin(req);
    const body = parse(patchSchema, req.body);
    if (req.params.id === admin.user.id) throw AppError.forbidden('You cannot change your own role or status');
    const [target] = await ctx.db.select().from(users).where(eq(users.id, req.params.id));
    if (!target) throw AppError.notFound('User not found');

    const losingAdmin = target.role === 'ADMIN' && (body.role === 'MEMBER' || body.status === 'DISABLED');
    if (losingAdmin) {
      const [{ n } = { n: 0 }] = rowsOf<{ n: number }>(
        await ctx.db.execute(sql`SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> ${target.id}`),
      );
      if (n === 0) throw AppError.conflict('At least one active administrator must remain');
    }

    await ctx.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ ...(body.role && { role: body.role }), ...(body.status && { status: body.status }) })
        .where(eq(users.id, target.id));
      // disabling signs the user out everywhere (API keys are rejected by the status check)
      if (body.status === 'DISABLED') await tx.delete(sessions).where(eq(sessions.userId, target.id));
    });
    await audit(ctx, req, {
      action: 'user.update',
      resourceType: 'user',
      resourceId: target.id,
      metadata: { email: target.email, ...(body.role && { role: { from: target.role, to: body.role } }), ...(body.status && { status: { from: target.status, to: body.status } }) },
    });
    return { ok: true };
  });
}
