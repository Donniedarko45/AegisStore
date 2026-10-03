import { createHash } from 'node:crypto';
import { auditLogs, desc, sql, type Db } from '@aegis/db';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context';

const GENESIS = '0'.repeat(64);
const AUDIT_LOCK = 7243001;

export interface AuditEntry {
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  /** override the actor (used for system events and failed logins) */
  actor?: { id?: string | null; type: 'USER' | 'API_KEY' | 'SYSTEM' | 'ANONYMOUS'; label?: string | null };
}

/** Canonical form that is hashed; field order is part of the on-disk format. */
function canonical(prevHash: string, r: {
  actorId: string | null;
  actorType: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: unknown;
  requestId: string | null;
  createdAt: Date;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        prevHash,
        r.actorId,
        r.actorType,
        r.action,
        r.resourceType,
        r.resourceId,
        r.metadata,
        r.requestId,
        r.createdAt.toISOString(),
      ]),
    )
    .digest('hex');
}

/**
 * Append an entry to the tamper-evident audit chain (each row hashes the previous one).
 * Never throws: an audit failure must not break the user's request, but it is logged loudly.
 */
export async function audit(ctx: Pick<AppContext, 'db' | 'log'>, req: FastifyRequest | null, entry: AuditEntry) {
  try {
    const principal = req?.principal ?? null;
    const actor = entry.actor ?? {
      id: principal?.user.id ?? null,
      type: principal ? principal.kind : 'ANONYMOUS',
      label: principal?.user.email ?? null,
    };
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK})`);
      const [last] = await tx.select({ h: auditLogs.rowHash }).from(auditLogs).orderBy(desc(auditLogs.seq)).limit(1);
      const prevHash = last?.h ?? GENESIS;
      const row = {
        actorId: actor.id ?? null,
        actorType: actor.type,
        action: entry.action,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        metadata: entry.metadata ?? {},
        requestId: (req?.id as string | undefined) ?? null,
        createdAt: new Date(),
      };
      await tx.insert(auditLogs).values({
        ...row,
        actorLabel: actor.label ?? null,
        ip: req?.ip ?? null,
        userAgent: req?.headers['user-agent']?.slice(0, 300) ?? null,
        prevHash,
        rowHash: canonical(prevHash, row),
      });
    });
  } catch (err) {
    ctx.log.error({ err, action: entry.action }, 'AUDIT WRITE FAILED');
  }
}

/** Recompute the whole chain; returns the first broken sequence number, if any. */
export async function verifyAuditChain(db: Db): Promise<{ ok: boolean; checked: number; brokenAtSeq?: number }> {
  const rows = await db.select().from(auditLogs).orderBy(auditLogs.seq);
  let prev = GENESIS;
  for (const r of rows) {
    const expected = canonical(prev, r);
    if (r.prevHash !== prev || r.rowHash !== expected) {
      return { ok: false, checked: rows.length, brokenAtSeq: r.seq };
    }
    prev = r.rowHash;
  }
  return { ok: true, checked: rows.length };
}
