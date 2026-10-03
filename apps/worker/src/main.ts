import { utimes, writeFile } from 'node:fs/promises';
import { createDb } from '@aegis/db';
import { StorageClient } from '@aegis/nodeclient';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadConfig } from './config';
import { runGc } from './jobs/gc';
import { sweepNodeHealth } from './jobs/health-sweeper';
import { rollupMetrics } from './jobs/metrics-rollup';
import { purgeExpired } from './jobs/retention-purge';
import { classifyObjects, pruneAccess } from './jobs/classifier';
import { JobRunner, reconcile, scrub } from './jobs/healing';
import { scoreNodes } from './jobs/risk-scorer';
import { becomeLeader } from './leader';
import type { WorkerCtx } from './util';

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { svc: 'worker' } });
const { db, pool } = createDb(cfg.DATABASE_URL, { max: 5 });
const storage = new StorageClient(cfg.NODE_SHARED_SECRET);

// Redis is best-effort (events only); the worker never depends on it for correctness.
const redis = new Redis(cfg.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', () => undefined);
void redis.connect().catch(() => undefined);

const abort = new AbortController();

/** Liveness for the container healthcheck: touched by every scheduler tick (and while waiting to lead). */
const ALIVE_FILE = process.env.WORKER_ALIVE_FILE ?? '/tmp/aegis-worker-alive';
const touchAlive = async () => {
  const now = new Date();
  await utimes(ALIVE_FILE, now, now).catch(() => writeFile(ALIVE_FILE, '').catch(() => undefined));
};
void touchAlive();
const aliveTimer = setInterval(() => void touchAlive(), 5000);
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
  clearInterval(aliveTimer);
  redis.disconnect();
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

log.info('worker starting; waiting for scheduler leadership');
const leader = await becomeLeader(pool, log, abort.signal, (err) => {
  // the advisory lock died with the connection: stop at once so we can never run as a second leader
  log.fatal({ err: String(err) }, 'lost scheduler leadership; exiting for a clean re-election');
  process.exit(1);
});
if (leader) {
  const ctx: WorkerCtx = { db, redis, log };
  const heal = { offlineAfterMs: cfg.OFFLINE_AFTER_MS, healGraceMs: cfg.HEAL_GRACE_MS, vnodes: cfg.VNODES_PER_NODE };
  const runner = new JobRunner(ctx, storage, { ...heal, concurrency: cfg.REPAIR_CONCURRENCY });
  await runner.recover();
  every('health-sweeper', cfg.SWEEP_INTERVAL_MS, () => sweepNodeHealth(db, redis, log, cfg.OFFLINE_AFTER_MS));
  every('metrics-rollup', cfg.METRICS_ROLLUP_INTERVAL_MS, () => rollupMetrics(db));
  every('gc', cfg.GC_INTERVAL_MS, () => runGc(db, storage, log, cfg.METRICS_RETENTION_DAYS));
  every('retention-purge', cfg.PURGE_INTERVAL_MS, () => purgeExpired(db, storage, log));
  every('risk-scorer', cfg.RISK_INTERVAL_MS, () => scoreNodes(ctx, { offlineAfterMs: cfg.OFFLINE_AFTER_MS, heartbeatIntervalMs: cfg.HEARTBEAT_INTERVAL_MS }));
  every('reconciler', cfg.RECONCILE_INTERVAL_MS, () => reconcile(ctx, heal));
  every('scrubber', cfg.SCRUB_INTERVAL_MS, () => scrub(ctx, { offlineAfterMs: cfg.OFFLINE_AFTER_MS, batch: cfg.SCRUB_BATCH, maxAgeHours: cfg.SCRUB_MAX_AGE_HOURS }));
  every('job-runner', cfg.JOB_POLL_MS, () => runner.tick());
  every('classifier', cfg.CLASSIFY_INTERVAL_MS, () =>
    classifyObjects(ctx, {
      hotReads24h: cfg.HOT_READS_24H,
      hotReads7d: cfg.HOT_READS_7D,
      hotDemoteHours: cfg.HOT_DEMOTE_HOURS,
      coldAfterDays: cfg.COLD_AFTER_DAYS,
      hotReplicas: cfg.HOT_REPLICAS,
    }),
  );
  every('access-prune', cfg.GC_INTERVAL_MS, () => pruneAccess(ctx, Math.max(8, cfg.COLD_AFTER_DAYS + 1)));
  log.info('schedulers running');
}
