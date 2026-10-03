import { readFileSync } from 'node:fs';
import { sql } from '@aegis/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { rowsOf } from '../core/http';
import { requireUser } from '../plugins/auth';

const version = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();
const startedAt = new Date().toISOString();

/** Cluster configuration and component status (shown in Settings → System, used by the e2e suite). */
export function systemRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/system', async (req) => {
    requireUser(req);
    let redis: 'up' | 'down' = 'down';
    try {
      if (ctx.redis && (await ctx.redis.ping()) === 'PONG') redis = 'up';
    } catch {
      /* down */
    }
    const [db] = rowsOf<{ version: string }>(await ctx.db.execute(sql`SELECT current_setting('server_version') AS version`));
    return {
      version,
      startedAt,
      components: { api: 'up', database: db ? 'up' : 'down', postgresVersion: db?.version ?? null, redis },
      config: {
        replicationFactor: ctx.cfg.REPLICATION_FACTOR,
        vnodesPerNode: ctx.cfg.VNODES_PER_NODE,
        offlineAfterMs: ctx.cfg.OFFLINE_AFTER_MS,
        probationBeats: ctx.cfg.PROBATION_BEATS,
        maxUploadBytes: ctx.cfg.MAX_UPLOAD_BYTES,
        verifyBufferMaxBytes: ctx.cfg.VERIFY_BUFFER_MAX_BYTES,
        retentionHours: ctx.cfg.RETENTION_HOURS,
      },
    };
  });
}
