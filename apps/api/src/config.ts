import { z } from 'zod';
import { DEFAULTS, envBool, envInt, parseEnv } from '@aegis/shared';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: envInt(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  NODE_SHARED_SECRET: z.string().min(8),
  ADMIN_EMAIL: z.string().email().default('admin@aegis.local'),
  ADMIN_PASSWORD: z.string().min(8).default('ChangeMe123!'),
  REPLICATION_FACTOR: envInt(DEFAULTS.replicationFactor),
  VNODES_PER_NODE: envInt(DEFAULTS.vnodesPerNode),
  OFFLINE_AFTER_MS: envInt(DEFAULTS.offlineAfterMs),
  PROBATION_BEATS: envInt(DEFAULTS.probationBeats),
  MAX_UPLOAD_BYTES: envInt(DEFAULTS.maxUploadBytes),
  VERIFY_BUFFER_MAX_BYTES: envInt(DEFAULTS.verifyBufferMaxBytes),
  RETENTION_HOURS: envInt(DEFAULTS.retentionHours),
  SESSION_TTL_DAYS: envInt(7),
  COOKIE_SECURE: envBool(false),
  ALLOWED_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema> & { allowedOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = parseEnv(schema, env);
  return {
    ...c,
    allowedOrigins: c.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
