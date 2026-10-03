import { appendAudit, type Db } from '@aegis/db';
import type { Redis } from 'ioredis';

export const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

/** Everything a background job needs. */
export interface WorkerCtx {
  db: Db;
  redis: Redis | null;
  log: import('pino').Logger;
}

export async function publish(redis: Redis | null, type: string, data: Record<string, unknown>) {
  await redis?.publish('ch:events', JSON.stringify({ type, data, at: new Date().toISOString() })).catch(() => undefined);
}

/** Audit entry written by a background component (actor type SYSTEM). Never throws. */
export async function systemAudit(
  ctx: WorkerCtx,
  actor: string,
  action: string,
  resource: { type: string; id: string | null },
  metadata: Record<string, unknown>,
) {
  try {
    await appendAudit(ctx.db, {
      actorId: null,
      actorType: 'SYSTEM',
      actorLabel: actor,
      action,
      resourceType: resource.type,
      resourceId: resource.id,
      metadata,
      requestId: null,
    });
  } catch (err) {
    ctx.log.error({ err, action }, 'AUDIT WRITE FAILED');
  }
}
