import { createDb } from '@aegis/db';
import { StorageClient } from '@aegis/nodeclient';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadConfig } from './config';
import { runGc } from './jobs/gc';
import { sweepNodeHealth } from './jobs/health-sweeper';
import { rollupMetrics } from './jobs/metrics-rollup';
import { becomeLeader } from './leader';

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { svc: 'worker' } });
const { db, pool } = createDb(cfg.DATABASE_URL, { max: 5 });
const storage = new StorageClient(cfg.NODE_SHARED_SECRET);

// Redis is best-effort (events only); the worker never depends on it for correctness.
const redis = new Redis(cfg.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', () => undefined);
void redis.connect().catch(() => undefined);

const abort = new AbortController();
const timers: NodeJS.Timeout[] = [];

/** Run `fn` every `ms`, never overlapping itself, never crashing the process. */
function every(name: string, ms: number, fn: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log.error({ err, job: name }, 'job failed');
    } finally {
      running = false;
    }
  };
  void tick();
  timers.push(setInterval(tick, ms));
}

const shutdown = async () => {
  abort.abort();
  timers.forEach(clearInterval);
  redis.disconnect();
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

log.info('worker starting; waiting for scheduler leadership');
const leader = await becomeLeader(pool, log, abort.signal);
if (leader) {
  every('health-sweeper', cfg.SWEEP_INTERVAL_MS, () => sweepNodeHealth(db, redis, log, cfg.OFFLINE_AFTER_MS));
  every('metrics-rollup', cfg.METRICS_ROLLUP_INTERVAL_MS, () => rollupMetrics(db));
  every('gc', cfg.GC_INTERVAL_MS, () => runGc(db, storage, log, cfg.METRICS_RETENTION_DAYS));
  log.info('schedulers running');
}
