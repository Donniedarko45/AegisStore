import { sql } from '@aegis/db';
import { publish, rows, systemAudit, type WorkerCtx } from '../util';

/**
 * Ransomware / anomaly detection (architecture §9.5).
 *
 * Threat model: a compromised account or API key (or malware using it) mass-deletes objects or
 * overwrites them with encrypted data. Detection reads the audit log (Postgres, so Redis stays
 * disposable) over a sliding 10-minute window per bucket x actor and combines signals:
 *
 *  - delete burst       many deletes per minute, or a large share of the bucket in 10 min
 *  - overwrite burst    many overwrites of existing objects per minute
 *  - entropy shift      a low-entropy object (text, documents) replaced by ~8 bits/byte data
 *  - extension churn    new keys with ransomware suffixes (.locked, .enc, .crypt …)
 *  - rate anomaly       request rate far above the actor's own baseline (z-score)
 *
 * On HIGH or CRITICAL: every version older than the attack start is marked protected (immutable,
 * exempt from purge), the bucket is locked if its owner opted in, and an alert is raised.
 */

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
const RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const BY_RANK: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface AnomalyConfig {
  deleteBurstPerMin: number;
  deleteSharePct: number;
  overwriteBurstPerMin: number;
  entropyShifts: number;
  extensionChurn: number;
  protectDays: number;
}

export interface Signal {
  signal: 'DELETE_BURST' | 'OVERWRITE_BURST' | 'ENTROPY_SHIFT' | 'EXTENSION_CHURN' | 'RATE_ANOMALY';
  value: number;
  threshold: number;
  severity: Severity;
  detail: string;
}

export interface WindowStats {
  deletes60s: number;
  deletes10m: number;
  overwrites60s: number;
  entropyShifts: number;
  suspiciousKeys: number;
  liveObjects: number;
  lastMinuteOps: number;
  baselineMean: number;
  baselineStd: number;
}

/** Pure scoring step (unit-tested): window statistics -> signals and an overall severity. */
export function evaluate(w: WindowStats, cfg: AnomalyConfig): { signals: Signal[]; severity: Severity | null; kind: string } {
  const signals: Signal[] = [];
  // share of the bucket deleted in the window, relative to what existed before
  const before = w.liveObjects + w.deletes10m;
  const share = before > 0 ? (w.deletes10m / before) * 100 : 0;
  if (w.deletes60s >= cfg.deleteBurstPerMin || (w.deletes10m >= 10 && share >= cfg.deleteSharePct)) {
    signals.push({
      signal: 'DELETE_BURST',
      value: Math.max(w.deletes60s, w.deletes10m),
      threshold: cfg.deleteBurstPerMin,
      severity: w.deletes10m >= cfg.deleteBurstPerMin * 4 || share >= 80 ? 'CRITICAL' : 'HIGH',
      detail: `${w.deletes10m} deletes in 10 min (${Math.round(share)}% of the bucket)`,
    });
  }
  if (w.overwrites60s >= cfg.overwriteBurstPerMin) {
    signals.push({ signal: 'OVERWRITE_BURST', value: w.overwrites60s, threshold: cfg.overwriteBurstPerMin, severity: 'MEDIUM', detail: `${w.overwrites60s} overwrites in the last minute` });
  }
  if (w.entropyShifts > 0) {
    signals.push({
      signal: 'ENTROPY_SHIFT',
      value: w.entropyShifts,
      threshold: cfg.entropyShifts,
      severity: w.entropyShifts >= cfg.entropyShifts * 4 ? 'CRITICAL' : w.entropyShifts >= cfg.entropyShifts ? 'HIGH' : 'LOW',
      detail: `${w.entropyShifts} low-entropy objects replaced with random-looking (encrypted) data`,
    });
  }
  if (w.suspiciousKeys >= 3) {
    signals.push({
      signal: 'EXTENSION_CHURN',
      value: w.suspiciousKeys,
      threshold: cfg.extensionChurn,
      severity: w.suspiciousKeys >= cfg.extensionChurn ? 'HIGH' : 'MEDIUM',
      detail: `${w.suspiciousKeys} new keys with ransomware-style extensions`,
    });
  }
  if (w.lastMinuteOps >= 30 && w.baselineStd > 0) {
    const z = (w.lastMinuteOps - w.baselineMean) / w.baselineStd;
    if (z >= 4) signals.push({ signal: 'RATE_ANOMALY', value: Math.round(z * 10) / 10, threshold: 4, severity: 'MEDIUM', detail: `${w.lastMinuteOps} writes/min vs a baseline of ${w.baselineMean.toFixed(1)} (z = ${z.toFixed(1)})` });
  }

  const meaningful = signals.filter((s) => RANK[s.severity] >= RANK.MEDIUM);
  if (!meaningful.length) return { signals, severity: null, kind: 'ANOMALY' };
  let rank = Math.max(...meaningful.map((s) => RANK[s.severity]));
  if (meaningful.length >= 2) rank = Math.min(RANK.CRITICAL, rank + 1); // corroborating signals
  const has = (k: Signal['signal']) => signals.some((s) => s.signal === k && RANK[s.severity] >= RANK.MEDIUM);
  const kind = has('ENTROPY_SHIFT') || has('EXTENSION_CHURN') ? 'RANSOMWARE' : has('DELETE_BURST') ? 'MASS_DELETE' : 'ANOMALY';
  return { signals, severity: BY_RANK[rank]!, kind };
}

interface Row {
  bucket: string;
  bucket_id: string;
  auto_lock: boolean;
  actor_id: string | null;
  actor_label: string | null;
  actor_type: string;
  deletes_60s: number;
  deletes_10m: number;
  overwrites_60s: number;
  entropy_shifts: number;
  suspicious_keys: number;
  last_minute_ops: number;
  live_objects: number;
  first_suspicious: Date | null;
  first_seen: Date;
  last_seen: Date;
}

const SUSPICIOUS = String.raw`\.(locked|lock|enc|encrypted|crypt|crypted|crypto|ransom|pay|cry|wncry|wcry|locky|zepto|cerber|r5a|aes|xtbl)$`;

export async function detectAnomalies(ctx: WorkerCtx, cfg: AnomalyConfig) {
  const windows = rows<Row>(
    await ctx.db.execute(sql`
      WITH w AS (
        SELECT a.*, b.id AS bucket_id, b.auto_lock
          FROM audit_logs a JOIN buckets b ON b.name = a.metadata->>'bucket' AND b.deleted_at IS NULL
         WHERE a.created_at > now() - interval '10 minutes'
           AND a.action IN ('object.upload', 'object.delete')
           AND a.actor_type IN ('USER', 'API_KEY', 'SIGNED_URL')
      ), agg AS (
        SELECT metadata->>'bucket' AS bucket, bucket_id, bool_or(auto_lock) AS auto_lock, actor_id,
               max(actor_label) AS actor_label, max(actor_type) AS actor_type,
               count(*) FILTER (WHERE action = 'object.delete' AND created_at > now() - interval '60 seconds')::int AS deletes_60s,
               count(*) FILTER (WHERE action = 'object.delete')::int AS deletes_10m,
               count(*) FILTER (WHERE action = 'object.upload' AND (metadata->>'overwrite')::boolean AND created_at > now() - interval '60 seconds')::int AS overwrites_60s,
               count(*) FILTER (WHERE action = 'object.upload' AND (metadata->>'entropy')::float8 >= 7.5 AND (metadata->>'prevEntropy')::float8 < 6)::int AS entropy_shifts,
               count(*) FILTER (WHERE action = 'object.upload' AND (metadata->>'key') ~* ${SUSPICIOUS})::int AS suspicious_keys,
               count(*) FILTER (WHERE created_at > now() - interval '60 seconds')::int AS last_minute_ops,
               -- an upload's version exists from the moment it started, not when its audit entry was written
               min(coalesce((metadata->>'startedAt')::timestamptz, created_at))
                 FILTER (WHERE action = 'object.delete'
                            OR (metadata->>'overwrite')::boolean
                            OR (metadata->>'key') ~* ${SUSPICIOUS}) AS first_suspicious,
               min(created_at) AS first_seen, max(created_at) AS last_seen
          FROM w GROUP BY 1, 2, 4
      )
      SELECT agg.*,
             (SELECT count(*)::int FROM objects o WHERE o.bucket_id = agg.bucket_id AND o.current_version_id IS NOT NULL) AS live_objects
        FROM agg
       WHERE deletes_10m >= 10 OR overwrites_60s >= 10 OR entropy_shifts > 0 OR suspicious_keys >= 3 OR last_minute_ops >= 30`),
  );

  for (const w of windows) {
    // baseline: this actor's writes per minute in this bucket over the previous hour
    const [base] = rows<{ mean: number; std: number }>(
      await ctx.db.execute(sql`
        WITH m AS (
          SELECT g AS minute, count(a.id) AS n
            FROM generate_series(date_trunc('minute', now() - interval '61 minutes'), date_trunc('minute', now() - interval '2 minutes'), interval '1 minute') g
            LEFT JOIN audit_logs a ON date_trunc('minute', a.created_at) = g
                                  AND a.action IN ('object.upload', 'object.delete')
                                  AND a.actor_id IS NOT DISTINCT FROM ${w.actor_id}::uuid
                                  AND a.metadata->>'bucket' = ${w.bucket}
           GROUP BY g)
        SELECT avg(n)::float8 AS mean, coalesce(stddev_pop(n), 0)::float8 AS std FROM m`),
    );
    const result = evaluate(
      {
        deletes60s: w.deletes_60s,
        deletes10m: w.deletes_10m,
        overwrites60s: w.overwrites_60s,
        entropyShifts: w.entropy_shifts,
        suspiciousKeys: w.suspicious_keys,
        liveObjects: w.live_objects,
        lastMinuteOps: w.last_minute_ops,
        baselineMean: base?.mean ?? 0,
        // a quiet actor has std 0; use a floor so a sudden burst still gives a finite z-score
        baselineStd: Math.max(base?.std ?? 0, 1),
      },
      cfg,
    );
    if (!result.severity) continue;
    await raise(ctx, cfg, w, result);
  }
}

async function raise(ctx: WorkerCtx, cfg: AnomalyConfig, w: Row, r: ReturnType<typeof evaluate>) {
  const start = w.first_suspicious ?? w.first_seen;
  const counts = {
    deletes: w.deletes_10m,
    overwrites60s: w.overwrites_60s,
    entropyShifts: w.entropy_shifts,
    suspiciousKeys: w.suspicious_keys,
    opsLastMinute: w.last_minute_ops,
  };
  // one open incident per bucket x actor: later windows update it instead of spamming alerts
  const [existing] = rows<{ id: string; severity: Severity; attack_start: Date; protected_versions: number; contained: boolean }>(
    await ctx.db.execute(sql`
      SELECT id, severity, attack_start, protected_versions, contained FROM security_events
       WHERE bucket_id = ${w.bucket_id} AND actor_id IS NOT DISTINCT FROM ${w.actor_id}::uuid
         AND status IN ('OPEN', 'ACKNOWLEDGED') AND last_seen_at > now() - interval '30 minutes'
       ORDER BY created_at DESC LIMIT 1`),
  );
  const severity: Severity = existing && RANK[existing.severity] > RANK[r.severity!] ? existing.severity : r.severity!;
  const attackStart = existing && new Date(existing.attack_start) < new Date(start) ? new Date(existing.attack_start) : new Date(start);

  let id: string;
  let escalated = false;
  if (existing) {
    id = existing.id;
    escalated = RANK[severity] > RANK[existing.severity];
    await ctx.db.execute(sql`
      UPDATE security_events
         SET severity = ${severity}, kind = ${r.kind}, signals = ${JSON.stringify(r.signals)}::jsonb, counts = ${JSON.stringify(counts)}::jsonb,
             attack_start = ${attackStart}, last_seen_at = ${new Date(w.last_seen)}, updated_at = now()
       WHERE id = ${id}`);
  } else {
    const [created] = rows<{ id: string }>(
      await ctx.db.execute(sql`
        INSERT INTO security_events (kind, severity, bucket_id, actor_id, actor_label, actor_type, signals, counts, attack_start, last_seen_at)
        VALUES (${r.kind}, ${severity}, ${w.bucket_id}, ${w.actor_id}, ${w.actor_label}, ${w.actor_type},
                ${JSON.stringify(r.signals)}::jsonb, ${JSON.stringify(counts)}::jsonb, ${attackStart}, ${new Date(w.last_seen)})
        RETURNING id`),
    );
    id = created!.id;
    escalated = true;
  }
  if (!escalated) return;

  let protectedVersions = existing?.protected_versions ?? 0;
  let contained = existing?.contained ?? false;
  if (RANK[severity] >= RANK.HIGH) {
    // Protect every pre-attack version (current, history and recently deleted alike): immutable and
    // exempt from the retention purge, so the clean data survives whatever the attacker does next.
    const [p] = rows<{ n: number }>(
      await ctx.db.execute(sql`
        WITH u AS (
          UPDATE object_versions v
             SET is_protected = true,
                 protected_until = greatest(coalesce(v.protected_until, now()), now() + make_interval(days => ${cfg.protectDays}))
            FROM objects o
           WHERE o.id = v.object_id AND o.bucket_id = ${w.bucket_id}
             AND v.created_at < ${attackStart} AND v.state IN ('ACTIVE', 'DELETED') AND v.is_delete_marker = false
          RETURNING v.id)
        SELECT count(*)::int AS n FROM u`),
    );
    protectedVersions += p?.n ?? 0;
    if (w.auto_lock && !contained) {
      await ctx.db.execute(sql`UPDATE buckets SET protected_mode = true WHERE id = ${w.bucket_id}`);
      contained = true;
    }
    await ctx.db.execute(sql`UPDATE security_events SET protected_versions = ${protectedVersions}, contained = ${contained} WHERE id = ${id}`);
  }

  const meta = { eventId: id, bucket: w.bucket, actor: w.actor_label, severity, kind: r.kind, signals: r.signals.map((s) => s.signal), protectedVersions, bucketLocked: contained };
  ctx.log.warn(meta, 'security alert');
  await systemAudit(ctx, 'anomaly-detector', 'security.alert', { type: 'security_event', id }, meta);
  void publish(ctx.redis, 'security.alert', meta);
}
