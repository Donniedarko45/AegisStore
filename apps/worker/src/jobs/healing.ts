import { HashRing } from '@aegis/hashring';
import { sql } from '@aegis/db';
import { CopyError, type NodeRef, type StorageClient } from '@aegis/nodeclient';
import { DURABLE_STATUSES, WRITABLE_STATUSES, type NodeStatus } from '@aegis/shared';
import { publish, rows, systemAudit, type WorkerCtx } from '../util';

/**
 * Self-healing (architecture §9.2), Kubernetes-style: the reconciler compares every ACTIVE
 * version's actual replicas with its target and enqueues jobs; the job runner executes them.
 * Work is always re-derived from Postgres, so a lost or failed job simply gets re-planned.
 *
 *  REPAIR_REPLICA  copy a verified replica to another node (or over a corrupt copy in place)
 *  TRIM_REPLICA    remove a replica that is no longer needed (extra copy, draining/high-risk node)
 *  VERIFY_REPLICA  re-hash a replica on its node (scrubbing, catches bit-rot)
 */

export interface HealConfig {
  offlineAfterMs: number;
  healGraceMs: number;
  vnodes: number;
}

interface NodeInfo {
  id: string;
  name: string;
  base_url: string;
  status: NodeStatus;
  fresh: boolean;
  offline_for_ms: number | null;
  vnode_count: number;
  free_bytes: number;
  disk_pct: number;
}

interface Rep {
  id: string;
  node_id: string;
  state: string;
}

interface Candidate {
  id: string;
  bucket_id: string;
  bucket: string;
  key: string;
  size: number;
  storage_class: string;
  target_replicas: number;
  reps: Rep[] | null;
}

const isDurable = (n: NodeInfo | undefined) => !!n && n.fresh && DURABLE_STATUSES.includes(n.status);
const isWritable = (n: NodeInfo | undefined, size: number) => !!n && n.fresh && WRITABLE_STATUSES.includes(n.status) && n.free_bytes > size;

let ringCache: { key: string; ring: HashRing } | null = null;
function ringOf(nodes: NodeInfo[], vnodes: number) {
  const key = `${vnodes}:${nodes.map((n) => n.id).sort().join(',')}`;
  if (ringCache?.key !== key) ringCache = { key, ring: new HashRing(nodes.map((n) => n.id), vnodes) };
  return ringCache.ring;
}

async function loadNodes(ctx: WorkerCtx, cfg: HealConfig) {
  return rows<NodeInfo>(
    await ctx.db.execute(sql`
      SELECT id, name, base_url, status, vnode_count,
             coalesce(last_heartbeat_at > now() - make_interval(secs => ${cfg.offlineAfterMs / 1000}), false) AS fresh,
             CASE WHEN status = 'OFFLINE' THEN (extract(epoch FROM now() - status_changed_at) * 1000)::float8 END AS offline_for_ms,
             (capacity_bytes - used_bytes)::float8 AS free_bytes,
             coalesce((last_metrics->>'diskUsedPct')::float8, 0) AS disk_pct
        FROM storage_nodes`),
  );
}

async function enqueue(
  ctx: WorkerCtx,
  job: { type: string; dedupeKey: string; priority: number; payload: Record<string, unknown>; reason: string; maxAttempts?: number },
): Promise<boolean> {
  const res = rows<{ id: string }>(
    await ctx.db.execute(sql`
      INSERT INTO jobs (type, dedupe_key, priority, payload, reason, max_attempts)
      VALUES (${job.type}, ${job.dedupeKey}, ${job.priority}, ${JSON.stringify(job.payload)}::jsonb, ${job.reason}, ${job.maxAttempts ?? 5})
      ON CONFLICT (dedupe_key) WHERE status IN ('QUEUED', 'RUNNING') DO NOTHING
      RETURNING id`),
  );
  return res.length > 0;
}

export interface ReconcileStatus {
  at: string;
  scanned: number;
  underReplicated: number;
  overReplicated: number;
  /** versions whose target cannot be met with the nodes currently available */
  cannotReachTarget: number;
  /** versions with no readable replica at all (data currently unreachable) */
  noSource: number;
  waitingGrace: number;
  enqueued: number;
}

// ---------------------------------------------------------------------------------------------
export async function reconcile(ctx: WorkerCtx, cfg: HealConfig): Promise<ReconcileStatus> {
  const nodes = await loadNodes(ctx, cfg);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ring = ringOf(nodes, cfg.vnodes);

  // Only versions that need attention: wrong number of durable replicas, or any replica that is
  // corrupt/missing or sits on a node being evacuated. Healthy versions cost one index scan.
  const candidates = rows<Candidate>(
    await ctx.db.execute(sql`
      WITH n AS (
        SELECT id, status, coalesce(last_heartbeat_at > now() - make_interval(secs => ${cfg.offlineAfterMs / 1000}), false) AS fresh
          FROM storage_nodes)
      SELECT v.id, o.bucket_id, b.name AS bucket, o.key, v.size, v.storage_class, v.target_replicas,
             json_agg(json_build_object('id', r.id, 'node_id', r.node_id, 'state', r.state)) FILTER (WHERE r.id IS NOT NULL) AS reps
        FROM object_versions v
        JOIN objects o ON o.id = v.object_id
        JOIN buckets b ON b.id = o.bucket_id
        LEFT JOIN replicas r ON r.version_id = v.id
        LEFT JOIN n ON n.id = r.node_id
       WHERE v.state = 'ACTIVE' AND v.is_delete_marker = false AND v.blob_id IS NOT NULL
       GROUP BY v.id, o.bucket_id, b.name, o.key
      HAVING count(*) FILTER (WHERE r.state = 'HEALTHY' AND n.fresh AND n.status IN ('HEALTHY', 'WARNING')) <> v.target_replicas
          OR bool_or(r.state IN ('CORRUPT', 'MISSING'))
          OR bool_or(n.status IN ('HIGH_RISK', 'DRAINING') AND r.state = 'HEALTHY')
       ORDER BY count(*) FILTER (WHERE r.state = 'HEALTHY' AND n.fresh AND n.status IN ('HEALTHY', 'WARNING')) ASC
       LIMIT 1000`),
  );

  const status: ReconcileStatus = {
    at: new Date().toISOString(),
    scanned: candidates.length,
    underReplicated: 0,
    overReplicated: 0,
    cannotReachTarget: 0,
    noSource: 0,
    waitingGrace: 0,
    enqueued: 0,
  };

  for (const v of candidates) {
    const reps = v.reps ?? [];
    const healthy = reps.filter((r) => r.state === 'HEALTHY');
    const good = healthy.filter((r) => isDurable(byId.get(r.node_id)));
    // replicas on a node that just missed heartbeats (not declared OFFLINE yet) or went OFFLINE
    // only moments ago: give it a chance to come back instead of thrashing on a quick restart
    const graced = healthy.filter((r) => {
      const n = byId.get(r.node_id);
      if (!n || isDurable(n)) return false;
      if (n.status === 'OFFLINE') return (n.offline_for_ms ?? Infinity) < cfg.healGraceMs;
      return !n.fresh && DURABLE_STATUSES.includes(n.status);
    });
    const readable = healthy.filter((r) => byId.get(r.node_id)?.fresh && byId.get(r.node_id)?.status !== 'OFFLINE');
    const priority = good.length <= 1 ? 10 : v.storage_class === 'HOT' ? 20 : 50;
    const base = { versionId: v.id, bucket: v.bucket, key: v.key };

    if (good.length < v.target_replicas) {
      status.underReplicated++;
      if (good.length + graced.length >= v.target_replicas) {
        status.waitingGrace++;
        continue;
      }
      if (!readable.length) {
        status.noSource++;
        continue;
      }
      // 1) fix a corrupt/missing copy in place when its node is fine (same path, no new node)
      const broken = reps.find((r) => (r.state === 'CORRUPT' || r.state === 'MISSING') && isWritable(byId.get(r.node_id), v.size));
      let target: string | undefined = broken?.node_id;
      let reason = broken ? (broken.state === 'CORRUPT' ? 'corrupt replica' : 'missing replica') : '';
      // 2) otherwise the next eligible node clockwise on the ring that holds no copy yet
      if (!target) {
        const holding = new Set(reps.map((r) => r.node_id));
        const [next] = ring.getNodes(`${v.bucket_id}/${v.key}@${v.id}`, 1, (id) => !holding.has(id) && isWritable(byId.get(id), v.size));
        target = next;
        const lost = reps.find((r) => !isDurable(byId.get(r.node_id)));
        const lostNode = lost ? byId.get(lost.node_id) : undefined;
        reason =
          lostNode?.status === 'OFFLINE' ? `${lostNode.name} offline`
          : lostNode?.status === 'HIGH_RISK' ? `${lostNode.name} high risk`
          : lostNode?.status === 'DRAINING' ? `${lostNode.name} draining`
          : healthy.length < v.target_replicas && v.storage_class === 'HOT' ? 'HOT object: extra replica'
          : 'under-replicated';
      }
      if (!target) {
        status.cannotReachTarget++;
        continue;
      }
      if (
        await enqueue(ctx, {
          type: 'REPAIR_REPLICA',
          dedupeKey: `ver:${v.id}`,
          priority,
          reason,
          payload: { ...base, targetNodeId: target, targetNode: byId.get(target)?.name, inPlace: !!broken },
        })
      )
        status.enqueued++;
      continue;
    }

    // Enough durable copies: remove what is no longer needed, one replica per tick per version.
    // Order of preference: broken rows, copies on draining / high-risk nodes, then an extra copy
    // on the fullest node. Never below the target.
    const removable =
      reps.find((r) => r.state === 'CORRUPT' || r.state === 'MISSING') ??
      healthy.find((r) => byId.get(r.node_id)?.fresh && byId.get(r.node_id)?.status === 'DRAINING') ??
      healthy.find((r) => byId.get(r.node_id)?.fresh && byId.get(r.node_id)?.status === 'HIGH_RISK') ??
      (good.length > v.target_replicas
        ? [...good].sort((a, b) => {
            const na = byId.get(a.node_id)!;
            const nb = byId.get(b.node_id)!;
            return (na.status === 'WARNING' ? 0 : 1) - (nb.status === 'WARNING' ? 0 : 1) || nb.disk_pct - na.disk_pct;
          })[0]
        : undefined);
    if (!removable) continue;
    if (good.length > v.target_replicas) status.overReplicated++;
    const node = byId.get(removable.node_id);
    if (
      await enqueue(ctx, {
        type: 'TRIM_REPLICA',
        dedupeKey: `ver:${v.id}`,
        priority: 150,
        reason:
          removable.state !== 'HEALTHY' ? `remove ${removable.state.toLowerCase()} replica`
          : node?.status === 'DRAINING' ? `${node.name} draining`
          : node?.status === 'HIGH_RISK' ? `${node.name} high risk`
          : 'over-replicated',
        payload: { ...base, replicaId: removable.id, node: node?.name },
      })
    )
      status.enqueued++;
  }

  await ctx.db.execute(sql`
    INSERT INTO settings (key, value, updated_at) VALUES ('reconciler.status', ${JSON.stringify(status)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`);
  if (status.enqueued) void publish(ctx.redis, 'healing.planned', { ...status });
  return status;
}

// ---------------------------------------------------------------------------------------------
/** Queue VERIFY_REPLICA for the replicas verified longest ago (rolling scrub). */
export async function scrub(ctx: WorkerCtx, cfg: { offlineAfterMs: number; batch: number; maxAgeHours: number }) {
  const due = rows<{ id: string; bucket: string; key: string; node: string }>(
    await ctx.db.execute(sql`
      SELECT r.id, b.name AS bucket, o.key, n.name AS node
        FROM replicas r
        JOIN storage_nodes n ON n.id = r.node_id
        JOIN object_versions v ON v.id = r.version_id
        JOIN objects o ON o.id = v.object_id
        JOIN buckets b ON b.id = o.bucket_id
       WHERE r.state = 'HEALTHY' AND v.state = 'ACTIVE' AND v.blob_id IS NOT NULL
         AND n.status <> 'OFFLINE' AND n.last_heartbeat_at > now() - make_interval(secs => ${cfg.offlineAfterMs / 1000})
         AND coalesce(r.last_verified_at, r.created_at) <
             now() - make_interval(hours => CASE WHEN v.storage_class = 'HOT' THEN least(24, ${cfg.maxAgeHours}) ELSE ${cfg.maxAgeHours} END)
       ORDER BY coalesce(r.last_verified_at, r.created_at)
       LIMIT ${cfg.batch}`),
  );
  let n = 0;
  for (const r of due) {
    if (await enqueue(ctx, { type: 'VERIFY_REPLICA', dedupeKey: `verify:${r.id}`, priority: 200, reason: 'scheduled scrub', payload: { replicaId: r.id, bucket: r.bucket, key: r.key, node: r.node }, maxAttempts: 3 })) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  reason: string | null;
  attempts: number;
  max_attempts: number;
}

class Skip extends Error {}

/**
 * Executes queued jobs with bounded concurrency so healing never starves user traffic.
 * Claims with FOR UPDATE SKIP LOCKED, so several runners could share the queue.
 */
export class JobRunner {
  private running = 0;
  constructor(
    private readonly ctx: WorkerCtx,
    private readonly storage: StorageClient,
    private readonly cfg: HealConfig & { concurrency: number },
  ) {}

  /** Jobs left RUNNING by a crashed leader go back to the queue. */
  async recover() {
    await this.ctx.db.execute(sql`UPDATE jobs SET status = 'QUEUED', started_at = NULL WHERE status = 'RUNNING'`);
  }

  async tick() {
    const free = this.cfg.concurrency - this.running;
    if (free <= 0) return;
    const claimed = rows<JobRow>(
      await this.ctx.db.execute(sql`
        UPDATE jobs SET status = 'RUNNING', started_at = now(), attempts = attempts + 1
         WHERE id IN (SELECT id FROM jobs WHERE status = 'QUEUED' AND run_after <= now()
                       ORDER BY priority, created_at LIMIT ${free} FOR UPDATE SKIP LOCKED)
        RETURNING id, type, payload, reason, attempts, max_attempts`),
    );
    for (const job of claimed) {
      this.running++;
      void this.execute(job).finally(() => this.running--);
    }
  }

  private async execute(job: JobRow) {
    const t0 = Date.now();
    void publish(this.ctx.redis, 'job.updated', { id: job.id, type: job.type, status: 'RUNNING', ...pick(job.payload) });
    try {
      const result = await this.run(job);
      await this.ctx.db.execute(sql`
        UPDATE jobs SET status = 'DONE', finished_at = now(), result = ${JSON.stringify({ ...result, ms: Date.now() - t0 })}::jsonb,
                        bytes = ${Number(result.bytes ?? 0)}, last_error = NULL
         WHERE id = ${job.id}`);
      void publish(this.ctx.redis, 'job.updated', { id: job.id, type: job.type, status: 'DONE', ...pick(job.payload) });
    } catch (err) {
      if (err instanceof Skip) {
        await this.ctx.db.execute(sql`
          UPDATE jobs SET status = 'CANCELLED', finished_at = now(), last_error = ${err.message} WHERE id = ${job.id}`);
        void publish(this.ctx.redis, 'job.updated', { id: job.id, type: job.type, status: 'CANCELLED', ...pick(job.payload) });
        return;
      }
      const msg = (err as Error).message.slice(0, 500);
      const final = job.attempts >= job.max_attempts;
      this.ctx.log.warn({ job: job.id, type: job.type, attempt: job.attempts, err: msg }, final ? 'job failed permanently' : 'job failed; will retry');
      await this.ctx.db.execute(sql`
        UPDATE jobs SET status = ${final ? 'FAILED' : 'QUEUED'}, last_error = ${msg},
                        finished_at = ${final ? sql`now()` : sql`NULL`},
                        run_after = now() + make_interval(secs => ${Math.min(300, 2 ** job.attempts * 2)})
         WHERE id = ${job.id}`);
      void publish(this.ctx.redis, 'job.updated', { id: job.id, type: job.type, status: final ? 'FAILED' : 'RETRY', ...pick(job.payload) });
    }
  }

  private run(job: JobRow): Promise<Record<string, unknown>> {
    if (job.type === 'REPAIR_REPLICA') return this.repair(job);
    if (job.type === 'TRIM_REPLICA') return this.trim(job);
    if (job.type === 'VERIFY_REPLICA') return this.verify(job);
    throw new Skip(`unknown job type ${job.type}`);
  }

  // ------------------------------------------------------------------------------- repair
  private async repair(job: JobRow) {
    const { versionId, targetNodeId } = job.payload as { versionId: string; targetNodeId: string };
    const [v] = rows<{ id: string; blob_id: string; sha256: string; size: number; state: string; bucket: string; key: string; object_id: string }>(
      await this.ctx.db.execute(sql`
        SELECT v.id, v.blob_id, v.sha256, v.size, v.state, b.name AS bucket, o.key, o.id AS object_id
          FROM object_versions v JOIN objects o ON o.id = v.object_id JOIN buckets b ON b.id = o.bucket_id
         WHERE v.id = ${versionId}`),
    );
    if (!v || v.state !== 'ACTIVE' || !v.blob_id || !v.sha256) throw new Skip('version no longer active');

    const nodes = await loadNodes(this.ctx, this.cfg);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const target = byId.get(targetNodeId);
    if (!isWritable(target, v.size)) throw new Skip(`target ${target?.name ?? targetNodeId} no longer eligible`);

    const reps = rows<Rep & { blob_path: string }>(
      await this.ctx.db.execute(sql`SELECT id, node_id, state, blob_path FROM replicas WHERE version_id = ${versionId}`),
    );
    const existing = reps.find((r) => r.node_id === targetNodeId);
    if (existing?.state === 'HEALTHY') throw new Skip('target already holds a healthy replica');

    const rank: Record<string, number> = { HEALTHY: 0, WARNING: 1, DRAINING: 2, HIGH_RISK: 3 };
    const sources = reps
      .filter((r) => r.state === 'HEALTHY' && r.node_id !== targetNodeId)
      .map((r) => ({ r, n: byId.get(r.node_id)! }))
      .filter(({ n }) => n && n.fresh && n.status !== 'OFFLINE')
      .sort((a, b) => (rank[a.n.status] ?? 9) - (rank[b.n.status] ?? 9));
    if (!sources.length) throw new Error('no readable source replica');

    const ref = (n: NodeInfo): NodeRef => ({ id: n.id, name: n.name, baseUrl: n.base_url });
    let copied: { size: number; path: string } | null = null;
    let from: NodeInfo | null = null;
    for (const s of sources) {
      try {
        copied = await this.storage.copyBlob(ref(s.n), ref(target!), v.blob_id, { sha256: v.sha256, size: v.size });
        from = s.n;
        break;
      } catch (err) {
        if (err instanceof CopyError && (err.kind === 'SOURCE_CORRUPT' || err.kind === 'SOURCE_MISSING')) {
          const state = err.kind === 'SOURCE_CORRUPT' ? 'CORRUPT' : 'MISSING';
          await this.ctx.db.execute(sql`UPDATE replicas SET state = ${state} WHERE id = ${s.r.id}`);
          await systemAudit(this.ctx, 'self-healing', state === 'CORRUPT' ? 'object.integrity_failure' : 'object.replica_missing', { type: 'replica', id: s.r.id }, {
            node: s.n.name, bucket: v.bucket, key: v.key, versionId, detectedBy: 'repair',
          });
          continue;
        }
        if (err instanceof CopyError && err.kind === 'SOURCE_UNAVAILABLE') continue;
        throw err;
      }
    }
    if (!copied || !from) throw new Error('every source replica failed');

    await this.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO replicas (version_id, node_id, blob_path, sha256, state, last_verified_at)
        VALUES (${versionId}, ${targetNodeId}, ${copied!.path}, ${v.sha256}, 'HEALTHY', now())
        ON CONFLICT (version_id, node_id) DO UPDATE SET state = 'HEALTHY', sha256 = excluded.sha256, last_verified_at = now(), blob_path = excluded.blob_path`);
      // the file on the target is now good for every version sharing this blob
      await tx.execute(sql`
        UPDATE replicas r SET state = 'HEALTHY', last_verified_at = now()
          FROM object_versions x
         WHERE x.id = r.version_id AND x.blob_id = ${v.blob_id} AND r.node_id = ${targetNodeId} AND r.state IN ('CORRUPT', 'MISSING')`);
    });
    const meta = { bucket: v.bucket, key: v.key, versionId, from: from.name, to: target!.name, reason: job.reason, bytes: v.size, inPlace: !!existing };
    await systemAudit(this.ctx, 'self-healing', 'replica.repaired', { type: 'object', id: v.object_id }, meta);
    void publish(this.ctx.redis, 'replica.repaired', meta);
    return { ...meta };
  }

  // --------------------------------------------------------------------------------- trim
  private async trim(job: JobRow) {
    const { replicaId } = job.payload as { replicaId: string };
    const [r] = rows<{ id: string; version_id: string; node_id: string; state: string; blob_id: string; target_replicas: number; bucket: string; key: string; object_id: string }>(
      await this.ctx.db.execute(sql`
        SELECT r.id, r.version_id, r.node_id, r.state, v.blob_id, v.target_replicas, b.name AS bucket, o.key, o.id AS object_id
          FROM replicas r JOIN object_versions v ON v.id = r.version_id JOIN objects o ON o.id = v.object_id JOIN buckets b ON b.id = o.bucket_id
         WHERE r.id = ${replicaId}`),
    );
    if (!r) throw new Skip('replica already gone');
    const nodes = await loadNodes(this.ctx, this.cfg);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const others = rows<Rep>(
      await this.ctx.db.execute(sql`SELECT id, node_id, state FROM replicas WHERE version_id = ${r.version_id} AND id <> ${replicaId}`),
    );
    const goodElsewhere = others.filter((o) => o.state === 'HEALTHY' && isDurable(byId.get(o.node_id))).length;
    // re-check at execution time: never drop below the target
    if (goodElsewhere < r.target_replicas) throw new Skip('removing it would drop below target');

    const node = byId.get(r.node_id);
    const [shared] = rows<{ n: number }>(
      await this.ctx.db.execute(sql`
        SELECT count(*)::int AS n FROM replicas x JOIN object_versions y ON y.id = x.version_id
         WHERE y.blob_id = ${r.blob_id} AND x.node_id = ${r.node_id} AND x.id <> ${replicaId}`),
    );
    if ((shared?.n ?? 0) === 0 && node) {
      // the bytes are only deleted when no other version still references this file on that node
      const ok = await this.storage.tryDeleteBlob({ id: node.id, name: node.name, baseUrl: node.base_url }, r.blob_id);
      if (!ok && r.state === 'HEALTHY') throw new Error(`${node.name} unreachable; cannot delete the extra copy yet`);
    }
    await this.ctx.db.execute(sql`DELETE FROM replicas WHERE id = ${replicaId}`);
    const meta = { bucket: r.bucket, key: r.key, versionId: r.version_id, node: node?.name, state: r.state, reason: job.reason };
    await systemAudit(this.ctx, 'self-healing', 'replica.trimmed', { type: 'object', id: r.object_id }, meta);
    void publish(this.ctx.redis, 'replica.trimmed', meta);
    return meta;
  }

  // ------------------------------------------------------------------------------- verify
  private async verify(job: JobRow) {
    const { replicaId } = job.payload as { replicaId: string };
    const [r] = rows<{ id: string; node_id: string; name: string; base_url: string; fresh: boolean; blob_id: string; sha256: string; size: number; bucket: string; key: string; version_id: string }>(
      await this.ctx.db.execute(sql`
        SELECT r.id, r.node_id, n.name, n.base_url, v.blob_id, v.sha256, v.size, b.name AS bucket, o.key, v.id AS version_id,
               coalesce(n.last_heartbeat_at > now() - make_interval(secs => ${this.cfg.offlineAfterMs / 1000}), false) AND n.status <> 'OFFLINE' AS fresh
          FROM replicas r JOIN storage_nodes n ON n.id = r.node_id JOIN object_versions v ON v.id = r.version_id
          JOIN objects o ON o.id = v.object_id JOIN buckets b ON b.id = o.bucket_id
         WHERE r.id = ${replicaId}`),
    );
    if (!r || !r.blob_id) throw new Skip('replica gone');
    if (!r.fresh) throw new Error(`${r.name} is not reachable`);
    const ref = { id: r.node_id, name: r.name, baseUrl: r.base_url };
    let state: 'HEALTHY' | 'CORRUPT' | 'MISSING';
    let actual: string | null = null;
    try {
      const res = await this.storage.verify(ref, r.blob_id);
      actual = res.sha256;
      state = res.sha256 === r.sha256 && res.size === Number(r.size) ? 'HEALTHY' : 'CORRUPT';
    } catch (err) {
      if ((err as { status?: number }).status === 404) state = 'MISSING';
      else throw err;
    }
    // the verdict is about the file, so it applies to every version sharing it on this node
    await this.ctx.db.execute(sql`
      UPDATE replicas x SET state = ${state}, last_verified_at = CASE WHEN ${state} = 'HEALTHY' THEN now() ELSE x.last_verified_at END
        FROM object_versions y
       WHERE y.id = x.version_id AND y.blob_id = ${r.blob_id} AND x.node_id = ${r.node_id} AND x.state IN ('HEALTHY', 'CORRUPT', 'MISSING')`);
    if (state !== 'HEALTHY') {
      await systemAudit(this.ctx, 'scrubber', state === 'CORRUPT' ? 'object.integrity_failure' : 'object.replica_missing', { type: 'replica', id: r.id }, {
        node: r.name, bucket: r.bucket, key: r.key, versionId: r.version_id, expected: r.sha256, actual, detectedBy: 'scrubber',
      });
      void publish(this.ctx.redis, 'replica.flagged', { node: r.name, state, versionId: r.version_id, bucket: r.bucket, key: r.key });
    }
    return { node: r.name, state, bucket: r.bucket, key: r.key };
  }
}

const pick = (p: Record<string, unknown>) => ({ bucket: p.bucket, key: p.key, versionId: p.versionId });
