import { apiKeys, and, buckets, eq, isNull, objectVersions, objects, replicas, securityEvents, sessions, sql } from '@aegis/db';
import { AppError } from '@aegis/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { audit } from '../core/audit';
import { iso, parse, rowsOf } from '../core/http';
import { publishEvent } from '../core/redis';
import { requireSiteAdmin } from '../plugins/auth';

type EventRow = typeof securityEvents.$inferSelect;

const listSchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE', 'ACTIVE']).optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const updateSchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE']).optional(),
  notes: z.string().max(2000).optional(),
});
const containSchema = z.object({
  lockBucket: z.boolean().default(true),
  revokeApiKeys: z.boolean().default(true),
  revokeSessions: z.boolean().default(false),
});

export interface PlanItem {
  key: string;
  /** restore: make the last clean version current; remove: object was created by the attack */
  action: 'restore' | 'remove' | 'unchanged' | 'unrecoverable';
  currentVersionNo: number | null;
  cleanVersionNo: number | null;
  currentEntropy: number | null;
  cleanEntropy: number | null;
  size: number | null;
}

async function loadEvent(ctx: AppContext, id: string) {
  const [row] = await ctx.db
    .select({ ev: securityEvents, bucket: buckets.name })
    .from(securityEvents)
    .leftJoin(buckets, eq(buckets.id, securityEvents.bucketId))
    .where(eq(securityEvents.id, id));
  if (!row) throw AppError.notFound('Security event not found');
  return row;
}

const toDto = (ev: EventRow, bucket: string | null) => ({
  id: ev.id,
  kind: ev.kind,
  severity: ev.severity,
  status: ev.status,
  bucket,
  actor: ev.actorLabel,
  actorId: ev.actorId,
  actorType: ev.actorType,
  signals: ev.signals,
  counts: ev.counts,
  attackStart: iso(ev.attackStart),
  lastSeenAt: iso(ev.lastSeenAt),
  protectedVersions: ev.protectedVersions,
  contained: ev.contained,
  notes: ev.notes,
  recovery: ev.recovery,
  resolvedAt: iso(ev.resolvedAt),
  createdAt: iso(ev.createdAt),
  updatedAt: iso(ev.updatedAt),
});

/** Every key the attacker touched in the attack window, and what recovery would do to it. */
export async function planRecovery(ctx: AppContext, ev: EventRow, bucketName: string): Promise<PlanItem[]> {
  const keys = rowsOf<{ key: string }>(
    await ctx.db.execute(sql`
      SELECT DISTINCT metadata->>'key' AS key FROM audit_logs
       WHERE action IN ('object.upload', 'object.delete')
         AND metadata->>'bucket' = ${bucketName}
         AND actor_id IS NOT DISTINCT FROM ${ev.actorId}::uuid
         AND created_at >= ${ev.attackStart}::timestamptz - interval '1 second'
         AND created_at <= ${ev.lastSeenAt}::timestamptz + interval '5 minutes'
       LIMIT 5000`),
  ).map((k) => k.key);
  if (!keys.length) return [];

  const versions = rowsOf<{
    key: string; id: string; version_no: number; is_current: boolean; is_delete_marker: boolean; state: string;
    created_at: Date; entropy: number | null; size: number; healthy: number;
  }>(
    await ctx.db.execute(sql`
      SELECT o.key, v.id, v.version_no, (o.current_version_id = v.id) AS is_current, v.is_delete_marker, v.state,
             v.created_at, v.entropy, v.size,
             (SELECT count(*) FROM replicas r WHERE r.version_id = v.id AND r.state = 'HEALTHY')::int AS healthy
        FROM objects o JOIN object_versions v ON v.object_id = o.id
       WHERE o.bucket_id = ${ev.bucketId} AND o.key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
       ORDER BY o.key, v.version_no DESC`),
  );
  const start = new Date(ev.attackStart).getTime();
  return keys.sort().map((key) => {
    const vs = versions.filter((v) => v.key === key);
    const cur = vs.find((v) => v.is_current) ?? null;
    const clean =
      vs.find((v) => new Date(v.created_at).getTime() < start && !v.is_delete_marker && (v.state === 'ACTIVE' || v.state === 'DELETED') && v.healthy > 0) ?? null;
    const base = {
      key,
      currentVersionNo: cur?.version_no ?? null,
      cleanVersionNo: clean?.version_no ?? null,
      currentEntropy: cur?.entropy ?? null,
      cleanEntropy: clean?.entropy ?? null,
      size: clean?.size ?? cur?.size ?? null,
    };
    if (clean) return { ...base, action: cur?.id === clean.id ? 'unchanged' : 'restore' } as PlanItem;
    if (cur && new Date(cur.created_at).getTime() >= start) return { ...base, action: 'remove' } as PlanItem;
    return { ...base, action: cur ? 'unchanged' : 'unrecoverable' } as PlanItem;
  });
}

/** Apply a recovery plan. Copy-on-restore: a new current version shares the clean blob (no bytes move). */
async function applyRecovery(ctx: AppContext, req: FastifyRequest, ev: EventRow, plan: PlanItem[]) {
  const retention = new Date(Date.now() + ctx.cfg.RETENTION_HOURS * 3_600_000);
  const userId = req.principal!.user.id;
  const result = { restored: 0, removed: 0, unchanged: 0, unrecoverable: 0, failed: [] as string[] };
  for (const item of plan) {
    if (item.action === 'unchanged' || item.action === 'unrecoverable') {
      result[item.action]++;
      continue;
    }
    try {
      await ctx.db.transaction(async (tx) => {
        const [obj] = await tx
          .select()
          .from(objects)
          .where(and(eq(objects.bucketId, ev.bucketId!), eq(objects.key, item.key)))
          .for('update');
        if (!obj) return;
        // the attack's own versions are taken out of service but kept (for forensics) until purge
        const quarantine = () =>
          tx.execute(sql`
            UPDATE object_versions SET state = 'DELETED', deleted_at = now(), purge_after = ${retention}
             WHERE object_id = ${obj.id} AND state = 'ACTIVE' AND created_at >= ${ev.attackStart}
               AND created_by IS NOT DISTINCT FROM ${ev.actorId}::uuid`);
        if (item.action === 'remove') {
          await quarantine();
          await tx.update(objects).set({ currentVersionId: null, updatedAt: new Date() }).where(eq(objects.id, obj.id));
          result.removed++;
          return;
        }
        const [clean] = await tx
          .select()
          .from(objectVersions)
          .where(and(eq(objectVersions.objectId, obj.id), eq(objectVersions.versionNo, item.cleanVersionNo!)));
        if (!clean) throw new Error('clean version vanished');
        const healthy = await tx.select().from(replicas).where(and(eq(replicas.versionId, clean.id), eq(replicas.state, 'HEALTHY')));
        if (!healthy.length) throw new Error('no healthy replica of the clean version');
        await quarantine();
        const [{ n } = { n: 0 }] = rowsOf<{ n: number }>(
          await tx.execute(sql`SELECT coalesce(max(version_no), 0)::int AS n FROM object_versions WHERE object_id = ${obj.id}`),
        );
        const [created] = await tx
          .insert(objectVersions)
          .values({
            objectId: obj.id,
            versionNo: n + 1,
            size: clean.size,
            contentType: clean.contentType,
            sha256: clean.sha256,
            blobId: clean.blobId,
            entropy: clean.entropy,
            state: 'ACTIVE',
            storageClass: clean.storageClass,
            targetReplicas: clean.targetReplicas,
            createdBy: userId,
          })
          .returning();
        await tx.insert(replicas).values(
          healthy.map((r) => ({ versionId: created!.id, nodeId: r.nodeId, blobPath: r.blobPath, sha256: r.sha256, state: 'HEALTHY' as const, lastVerifiedAt: r.lastVerifiedAt })),
        );
        await tx.update(objects).set({ currentVersionId: created!.id, updatedAt: new Date() }).where(eq(objects.id, obj.id));
        result.restored++;
      });
    } catch (err) {
      result.failed.push(`${item.key}: ${(err as Error).message}`);
    }
  }
  return result;
}

export function securityRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/security/summary', async (req) => {
    requireSiteAdmin(req);
    const bySeverity = rowsOf<{ severity: string; n: number }>(
      await ctx.db.execute(sql`SELECT severity, count(*)::int AS n FROM security_events WHERE status IN ('OPEN', 'ACKNOWLEDGED') GROUP BY 1`),
    );
    const locked = rowsOf<{ name: string }>(
      await ctx.db.execute(sql`SELECT name FROM buckets WHERE protected_mode AND deleted_at IS NULL ORDER BY name`),
    );
    const [prot] = rowsOf<{ n: number }>(
      await ctx.db.execute(sql`SELECT count(*)::int AS n FROM object_versions WHERE is_protected AND (protected_until IS NULL OR protected_until > now())`),
    );
    const daily = rowsOf<{ day: Date; severity: string; n: number }>(
      await ctx.db.execute(sql`
        SELECT date_trunc('day', created_at) AS day, severity, count(*)::int AS n FROM security_events
         WHERE created_at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 1`),
    );
    return {
      open: bySeverity.reduce((a, r) => a + r.n, 0),
      bySeverity: Object.fromEntries(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => [s, bySeverity.find((r) => r.severity === s)?.n ?? 0])),
      lockedBuckets: locked.map((b) => b.name),
      protectedVersions: prot?.n ?? 0,
      daily: daily.map((d) => ({ day: iso(d.day), severity: d.severity, n: d.n })),
    };
  });

  app.get('/api/security/events', async (req) => {
    requireSiteAdmin(req);
    const q = parse(listSchema, req.query);
    const rows = await ctx.db
      .select({ ev: securityEvents, bucket: buckets.name })
      .from(securityEvents)
      .leftJoin(buckets, eq(buckets.id, securityEvents.bucketId))
      .where(
        and(
          q.status === 'ACTIVE'
            ? sql`${securityEvents.status} IN ('OPEN', 'ACKNOWLEDGED')`
            : q.status
              ? eq(securityEvents.status, q.status)
              : undefined,
          q.severity ? eq(securityEvents.severity, q.severity) : undefined,
        ),
      )
      .orderBy(sql`${securityEvents.status} IN ('OPEN', 'ACKNOWLEDGED') DESC`, sql`${securityEvents.createdAt} DESC`)
      .limit(q.limit);
    return { items: rows.map((r) => toDto(r.ev, r.bucket)) };
  });

  app.get<{ Params: { id: string } }>('/api/security/events/:id', async (req) => {
    requireSiteAdmin(req);
    const { ev, bucket } = await loadEvent(ctx, req.params.id);
    // what the actor did around the attack, minute by minute (timeline chart)
    const timeline = rowsOf<{ t: Date; uploads: number; deletes: number; suspicious: number }>(
      await ctx.db.execute(sql`
        SELECT date_trunc('minute', created_at) AS t,
               count(*) FILTER (WHERE action = 'object.upload')::int AS uploads,
               count(*) FILTER (WHERE action = 'object.delete')::int AS deletes,
               count(*) FILTER (WHERE (metadata->>'entropy')::float8 >= 7.5 AND (metadata->>'prevEntropy')::float8 < 6)::int AS suspicious
          FROM audit_logs
         WHERE action IN ('object.upload', 'object.delete') AND metadata->>'bucket' = ${bucket ?? ''}
           AND actor_id IS NOT DISTINCT FROM ${ev.actorId}::uuid
           AND created_at BETWEEN ${ev.attackStart}::timestamptz - interval '15 minutes' AND ${ev.lastSeenAt}::timestamptz + interval '5 minutes'
         GROUP BY 1 ORDER BY 1`),
    );
    const recent = rowsOf<{ action: string; key: string; at: Date; entropy: number | null; prev: number | null }>(
      await ctx.db.execute(sql`
        SELECT action, metadata->>'key' AS key, created_at AS at, (metadata->>'entropy')::float8 AS entropy, (metadata->>'prevEntropy')::float8 AS prev
          FROM audit_logs
         WHERE action IN ('object.upload', 'object.delete') AND metadata->>'bucket' = ${bucket ?? ''}
           AND actor_id IS NOT DISTINCT FROM ${ev.actorId}::uuid
           AND created_at BETWEEN ${ev.attackStart}::timestamptz - interval '1 second' AND ${ev.lastSeenAt}::timestamptz + interval '5 minutes'
         ORDER BY seq DESC LIMIT 50`),
    );
    return {
      event: toDto(ev, bucket),
      timeline: timeline.map((r) => ({ ...r, t: iso(r.t) })),
      actions: recent.map((r) => ({ ...r, at: iso(r.at) })),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/security/events/:id', async (req) => {
    const p = requireSiteAdmin(req);
    const body = parse(updateSchema, req.body);
    const { ev } = await loadEvent(ctx, req.params.id);
    const closing = body.status === 'RESOLVED' || body.status === 'FALSE_POSITIVE';
    const [updated] = await ctx.db
      .update(securityEvents)
      .set({
        ...(body.status && { status: body.status }),
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(closing && { resolvedAt: new Date(), resolvedBy: p.user.id }),
        updatedAt: new Date(),
      })
      .where(eq(securityEvents.id, ev.id))
      .returning();
    await audit(ctx, req, { action: 'security.event_updated', resourceType: 'security_event', resourceId: ev.id, metadata: { from: ev.status, to: updated!.status } });
    void publishEvent(ctx.redis, 'security.updated', { eventId: ev.id, status: updated!.status });
    return { ok: true, status: updated!.status };
  });

  // Stop the bleeding: lock the bucket, revoke the actor's API keys (and optionally sessions).
  app.post<{ Params: { id: string } }>('/api/security/events/:id/contain', async (req) => {
    const p = requireSiteAdmin(req);
    const body = parse(containSchema, req.body ?? {});
    const { ev, bucket } = await loadEvent(ctx, req.params.id);
    const done: Record<string, number | boolean> = {};
    if (body.lockBucket && ev.bucketId) {
      await ctx.db.update(buckets).set({ protectedMode: true }).where(eq(buckets.id, ev.bucketId));
      done.bucketLocked = true;
    }
    if (ev.actorId && body.revokeApiKeys) {
      const revoked = await ctx.db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.userId, ev.actorId), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      done.apiKeysRevoked = revoked.length;
    }
    if (ev.actorId && body.revokeSessions && ev.actorId !== p.user.id) {
      const gone = await ctx.db.delete(sessions).where(eq(sessions.userId, ev.actorId)).returning({ id: sessions.id });
      done.sessionsRevoked = gone.length;
    }
    await ctx.db
      .update(securityEvents)
      .set({ contained: ev.contained || !!done.bucketLocked, status: ev.status === 'OPEN' ? 'ACKNOWLEDGED' : ev.status, updatedAt: new Date() })
      .where(eq(securityEvents.id, ev.id));
    await audit(ctx, req, { action: 'security.contain', resourceType: 'security_event', resourceId: ev.id, metadata: { bucket, actor: ev.actorLabel, ...done } });
    void publishEvent(ctx.redis, 'security.updated', { eventId: ev.id, bucket });
    return { ok: true, ...done };
  });

  app.get<{ Params: { id: string } }>('/api/security/events/:id/recovery', async (req) => {
    requireSiteAdmin(req);
    const { ev, bucket } = await loadEvent(ctx, req.params.id);
    if (!bucket || !ev.bucketId) throw AppError.validation('This event is not tied to a bucket');
    const plan = await planRecovery(ctx, ev, bucket);
    const count = (a: PlanItem['action']) => plan.filter((p) => p.action === a).length;
    return {
      bucket,
      attackStart: iso(ev.attackStart),
      summary: { restore: count('restore'), remove: count('remove'), unchanged: count('unchanged'), unrecoverable: count('unrecoverable') },
      items: plan,
    };
  });

  app.post<{ Params: { id: string } }>('/api/security/events/:id/recover', async (req) => {
    const p = requireSiteAdmin(req);
    const { ev, bucket } = await loadEvent(ctx, req.params.id);
    if (!bucket || !ev.bucketId) throw AppError.validation('This event is not tied to a bucket');
    const plan = await planRecovery(ctx, ev, bucket);
    const result = await applyRecovery(ctx, req, ev, plan);
    const recovery = { ...result, at: new Date().toISOString(), by: p.user.email };
    await ctx.db
      .update(securityEvents)
      .set({ status: 'RESOLVED', recovery, resolvedAt: new Date(), resolvedBy: p.user.id, updatedAt: new Date() })
      .where(eq(securityEvents.id, ev.id));
    await audit(ctx, req, { action: 'security.recover', resourceType: 'security_event', resourceId: ev.id, metadata: { bucket, ...result, failed: result.failed.length } });
    void publishEvent(ctx.redis, 'object.created', { bucket, recovered: true });
    void publishEvent(ctx.redis, 'security.updated', { eventId: ev.id, bucket });
    return { ok: true, ...recovery };
  });
}
