import { appendAudit, sql, type Db } from '@aegis/db';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** Mark nodes OFFLINE when no heartbeat arrived within `offlineAfterMs`. */
export async function sweepNodeHealth(db: Db, redis: Redis | null, log: Logger, offlineAfterMs: number) {
  const res = await db.execute(sql`
    UPDATE storage_nodes
       SET status = 'OFFLINE', probation_beats = 0, status_changed_at = now()
     WHERE status <> 'OFFLINE'
       AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - make_interval(secs => ${offlineAfterMs / 1000}))
    RETURNING id, name, last_heartbeat_at`);
  const rows = (res as unknown as { rows: { id: string; name: string; last_heartbeat_at: Date | null }[] }).rows;
  for (const n of rows) {
    log.warn({ node: n.name }, 'node marked OFFLINE (missed heartbeats)');
    await appendAudit(db, {
      actorId: null,
      actorType: 'SYSTEM',
      actorLabel: 'health-sweeper',
      action: 'node.offline',
      resourceType: 'node',
      resourceId: n.id,
      metadata: { name: n.name, lastHeartbeatAt: n.last_heartbeat_at, offlineAfterMs },
      requestId: null,
    });
    await redis?.publish('ch:events', JSON.stringify({ type: 'node.status', data: { name: n.name, status: 'OFFLINE' }, at: new Date().toISOString() })).catch(() => undefined);
  }
  return rows.length;
}
