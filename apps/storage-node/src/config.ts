import { z } from 'zod';
import { DEFAULTS, envInt, parseEnv } from '@aegis/shared';

const schema = z.object({
  NODE_NAME: z.string().min(1).default('storage-node-1'),
  PORT: envInt(4000),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./runtime/storage-node-1'),
  /** how the control plane reaches this node (registered via heartbeat) */
  PUBLIC_URL: z.string().url().optional(),
  API_URL: z.string().url().default('http://localhost:3000'),
  NODE_SHARED_SECRET: z.string().min(8),
  HEARTBEAT_INTERVAL_MS: envInt(DEFAULTS.heartbeatIntervalMs),
  NODE_CAPACITY_BYTES: z.coerce.number().int().positive().default(10 * 1024 ** 3),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema> & { publicUrl: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = parseEnv(schema, env);
  return { ...c, publicUrl: c.PUBLIC_URL ?? `http://${c.NODE_NAME}:${c.PORT}` };
}
