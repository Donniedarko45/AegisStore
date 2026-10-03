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
  /** per source IP per hour */
  REGISTER_RATE_LIMIT: envInt(10),
  /** per source IP + email per 15 minutes */
  LOGIN_RATE_LIMIT: envInt(10),
  COOKIE_SECURE: envBool(false),
  /**
   * Number of reverse proxies in front of the API (nginx = 1). Fastify then takes the client IP
   * from the right place in X-Forwarded-For instead of trusting the left-most, client-supplied
   * entry, which would let anyone spoof their IP past the login rate limit.
   */
  TRUST_PROXY_HOPS: envInt(1),
  /** max downloads that may be buffered for verify-before-send at once (memory cap) */
  VERIFY_BUFFER_CONCURRENCY: envInt(8),
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
