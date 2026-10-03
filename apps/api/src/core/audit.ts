import { appendAudit, verifyAuditChain } from '@aegis/db';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context';

export { verifyAuditChain };

export interface AuditEntry {
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  /** override the actor (used for system events and failed logins) */
  actor?: { id?: string | null; type: 'USER' | 'API_KEY' | 'SYSTEM' | 'ANONYMOUS' | 'SIGNED_URL'; label?: string | null };
}

/**
 * Record an audit entry for the current request.
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
    await appendAudit(ctx.db, {
      actorId: actor.id ?? null,
      actorType: actor.type,
      actorLabel: actor.label ?? null,
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      metadata: entry.metadata ?? {},
      requestId: (req?.id as string | undefined) ?? null,
      ip: req?.ip ?? null,
      userAgent: req?.headers['user-agent']?.slice(0, 300) ?? null,
    });
  } catch (err) {
    ctx.log.error({ err, action: entry.action }, 'AUDIT WRITE FAILED');
  }
}
