import type { Pool, PoolClient } from '@aegis/db';
import type { Logger } from 'pino';

const WORKER_LOCK = 7243002;
const KEEPALIVE_MS = 10_000;

/**
 * Only one worker instance may run the schedulers. The leader holds a Postgres advisory lock on
 * a dedicated connection; if the process dies the connection drops and another worker takes over.
 *
 * The lock lives exactly as long as that connection. If it breaks (DB restart, network blip) the
 * lock is silently released while this process would keep scheduling, so two leaders could run.
 * `onLost` is called as soon as the connection fails a keepalive or errors; callers should exit
 * and let the supervisor restart them into a fresh election.
 */
export async function becomeLeader(pool: Pool, log: Logger, signal: AbortSignal, onLost: (err: unknown) => void): Promise<PoolClient | null> {
  while (!signal.aborted) {
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK]);
      if (res.rows[0]?.ok) {
        log.info('acquired scheduler leadership');
        const leader = client;
        let lost = false;
        const lose = (err: unknown) => {
          if (lost) return;
          lost = true;
          clearInterval(timer);
          onLost(err);
        };
        leader.on('error', lose);
        leader.on('end', () => lose(new Error('leader connection ended')));
        const timer = setInterval(() => {
          leader.query('SELECT 1').catch(lose);
        }, KEEPALIVE_MS);
        return leader;
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'leader election query failed');
    }
    client?.release();
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}
