import type { Pool, PoolClient } from '@aegis/db';
import type { Logger } from 'pino';

const WORKER_LOCK = 7243002;

/**
 * Only one worker instance may run the schedulers. The leader holds a Postgres advisory lock on
 * a dedicated connection; if the process dies the connection drops and another worker takes over.
 */
export async function becomeLeader(pool: Pool, log: Logger, signal: AbortSignal): Promise<PoolClient | null> {
  while (!signal.aborted) {
    const client = await pool.connect();
    try {
      const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK]);
      if (res.rows[0]?.ok) {
        log.info('acquired scheduler leadership');
        return client;
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'leader election query failed');
    }
    client.release();
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}
