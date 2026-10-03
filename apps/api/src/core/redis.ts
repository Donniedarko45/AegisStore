import { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Redis is ephemeral by design (NFR-4): losing it must never lose data or take the API down.
 * Commands fail fast (no offline queue) and every helper degrades to a no-op/allow.
 */
export function createRedis(url: string, log: FastifyBaseLogger): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (n) => Math.min(n * 500, 5000),
  });
  let warned = false;
  redis.on('error', (err) => {
    if (!warned) log.warn({ err: String(err) }, 'redis unavailable - continuing without it');
    warned = true;
  });
  redis.on('ready', () => {
    warned = false;
    log.info('redis connected');
  });
  void redis.connect().catch(() => undefined);
  return redis;
}

/** Fixed-window rate limit. Returns true when the call is allowed. Fails open if Redis is down. */
export async function rateLimit(
  redis: Redis | null,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  if (!redis) return true;
  try {
    const n = await redis.incr(`rl:${key}`);
    if (n === 1) await redis.expire(`rl:${key}`, windowSec);
    return n <= limit;
  } catch {
    return true;
  }
}

export async function publishEvent(redis: Redis | null, type: string, data: unknown): Promise<void> {
  if (!redis) return;
  try {
    await redis.publish('ch:events', JSON.stringify({ type, data, at: new Date().toISOString() }));
  } catch {
    /* best effort */
  }
}
