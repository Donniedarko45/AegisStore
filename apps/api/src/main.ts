import { createDb, runMigrations } from '@aegis/db';
import pino from 'pino';
import { ensureAdmin } from './bootstrap';
import { loadConfig } from './config';
import type { AppContext } from './context';
import { createRedis } from './core/redis';
import { StorageClient } from './core/storageclient';
import { buildApp } from './server';

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { svc: 'api' } });
const { db, pool } = createDb(cfg.DATABASE_URL, { max: 20 });

log.info('running database migrations');
await runMigrations(db);

const redis = createRedis(cfg.REDIS_URL, log as never);
const ctx: AppContext = {
  cfg,
  db,
  pool,
  redis,
  storage: new StorageClient(cfg.NODE_SHARED_SECRET),
  log: log as never,
};
await ensureAdmin(ctx);

const app = await buildApp(ctx);
await app.listen({ port: cfg.PORT, host: cfg.HOST });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  redis.disconnect();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
