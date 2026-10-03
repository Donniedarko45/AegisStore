import { EventEmitter } from 'node:events';
import { sql } from '@aegis/db';
import { Redis } from 'ioredis';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { rowsOf } from '../core/http';
import { visibleBucketIds } from '../core/visibility';
import { requireUser } from '../plugins/auth';

interface BusEvent {
  type: string;
  data: Record<string, unknown>;
  at: string;
}

/**
 * One Redis subscriber per API process fans events out to every connected browser.
 * Redis is optional: without it the stream stays open but quiet and the UI keeps polling.
 */
export function createEventHub(url: string, log: FastifyBaseLogger) {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const sub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null, retryStrategy: (n) => Math.min(n * 500, 5000) });
  sub.on('error', () => undefined);
  sub.on('message', (_ch, msg) => {
    try {
      bus.emit('event', JSON.parse(msg) as BusEvent);
    } catch {
      /* ignore malformed */
    }
  });
  sub
    .connect()
    .then(() => sub.subscribe('ch:events'))
    .then(() => log.info('live event hub subscribed'))
    .catch(() => log.warn('live event hub disabled (redis unavailable)'));
  return { bus, close: () => sub.disconnect() };
}

export function eventRoutes(app: FastifyInstance, ctx: AppContext, hub: ReturnType<typeof createEventHub>) {
  app.get('/api/events/stream', async (req, reply) => {
    const { user } = requireUser(req);
    const isAdmin = user.role === 'ADMIN';
    let visible = new Set<string>();
    const refreshVisible = async () => {
      const rows = rowsOf<{ name: string }>(await ctx.db.execute(sql`SELECT name FROM buckets WHERE id IN ${visibleBucketIds(user)}`));
      visible = new Set(rows.map((r) => r.name));
    };
    await refreshVisible();

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx: do not buffer this response
      'x-request-id': String(req.id),
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write('retry: 5000\n\n');
    send('ready', { at: new Date().toISOString() });

    const onEvent = (e: BusEvent) => {
      const bucket = typeof e.data?.bucket === 'string' ? e.data.bucket : null;
      // node health is cluster-wide information; object events only for buckets this user can see
      const allowed = e.type.startsWith('node.') || isAdmin || (bucket !== null && visible.has(bucket));
      if (allowed) send(e.type, { ...e.data, at: e.at });
    };
    hub.bus.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    const refresh = setInterval(() => void refreshVisible().catch(() => undefined), 30_000);
    req.raw.on('close', () => {
      hub.bus.off('event', onEvent);
      clearInterval(ping);
      clearInterval(refresh);
    });
  });
}
