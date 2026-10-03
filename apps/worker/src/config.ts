import { z } from 'zod';
import { DEFAULTS, envInt, parseEnv } from '@aegis/shared';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  NODE_SHARED_SECRET: z.string().min(8),
  OFFLINE_AFTER_MS: envInt(DEFAULTS.offlineAfterMs),
  SWEEP_INTERVAL_MS: envInt(5000),
  METRICS_ROLLUP_INTERVAL_MS: envInt(30_000),
  GC_INTERVAL_MS: envInt(10 * 60_000),
  PURGE_INTERVAL_MS: envInt(60_000),
  METRICS_RETENTION_DAYS: envInt(7),
  LOG_LEVEL: z.string().default('info'),
});
export type Config = z.infer<typeof schema>;
export const loadConfig = (): Config => parseEnv(schema);
