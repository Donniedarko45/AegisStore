import { sql } from '@aegis/db';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { verifyAuditChain } from '../core/audit';
import { iso, parse, rowsOf } from '../core/http';
import { requireSiteAdmin, requireUser } from '../plugins/auth';

const querySchema = z.object({
  actor: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  resource: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export function auditRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/audit', async (req) => {
    const { user } = requireUser(req);
    const q = parse(querySchema, req.query);
    const conds = [sql`true`];
    // members only ever see their own trail; administrators see everything
    if (user.role !== 'ADMIN') conds.push(sql`actor_id = ${user.id}`);
    if (q.actor) conds.push(sql`position(lower(${q.actor}) in lower(coalesce(actor_label, ''))) > 0`);
    if (q.action) conds.push(sql`action LIKE ${q.action.replace(/[%_\\]/g, '\\$&') + '%'}`);
    if (q.resource) conds.push(sql`resource_type = ${q.resource}`);
    if (q.from) conds.push(sql`created_at >= ${q.from}`);
    if (q.to) conds.push(sql`created_at <= ${q.to}`);
    if (q.q) conds.push(sql`(position(lower(${q.q}) in lower(action)) > 0 OR position(lower(${q.q}) in lower(coalesce(actor_label, ''))) > 0 OR position(lower(${q.q}) in lower(metadata::text)) > 0)`);
    const where = sql.join(conds, sql` AND `);

    const rows = rowsOf<{
      id: string; seq: number; action: string; actor_type: string; actor_label: string | null; resource_type: string | null;
      resource_id: string | null; ip: string | null; metadata: Record<string, unknown>; request_id: string | null; created_at: Date;
    }>(
      await ctx.db.execute(sql`
        SELECT id, seq, action, actor_type, actor_label, resource_type, resource_id, ip, metadata, request_id, created_at
        FROM audit_logs WHERE ${where}
        ORDER BY seq DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`),
    );
    const [count] = rowsOf<{ n: number }>(await ctx.db.execute(sql`SELECT count(*)::int AS n FROM audit_logs WHERE ${where}`));
    return {
      items: rows.map((r) => ({
        id: r.id,
        seq: Number(r.seq),
        action: r.action,
        actorType: r.actor_type,
        actor: r.actor_label,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        ip: r.ip,
        metadata: r.metadata,
        requestId: r.request_id,
        createdAt: iso(r.created_at),
      })),
      total: count?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  // Recomputes the hash chain; any edited or deleted row is detected.
  app.get('/api/audit/verify', async (req) => {
    requireSiteAdmin(req);
    return verifyAuditChain(ctx.db);
  });
}
