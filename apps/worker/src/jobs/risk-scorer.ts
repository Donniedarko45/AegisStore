import { sql } from '@aegis/db';
import { ewma, nextRiskStatus, scoreRisk, slope, type NodeMetrics, type NodeStatus, type RiskInputs } from '@aegis/shared';
import { publish, rows, systemAudit, type WorkerCtx } from '../util';

interface NodeRow {
  id: string;
  name: string;
  status: NodeStatus;
  last_metrics: NodeMetrics | null;
  risk_state: Record<string, number> | null;
  heartbeat_age_sec: number | null;
}

const ALPHA = 0.5;

const TRANSITION_ACTION: Partial<Record<NodeStatus, string>> = {
  WARNING: 'node.warning',
  HIGH_RISK: 'node.high_risk',
  HEALTHY: 'node.risk_cleared',
};

/**
 * Score every reachable node from its live metrics (EWMA-smoothed across ticks), its recent
 * history (disk fill trend, restarts, outages) and its replica integrity, then move it between
 * HEALTHY / WARNING / HIGH_RISK with hysteresis. OFFLINE and DRAINING nodes keep their status.
 */
export async function scoreNodes(ctx: WorkerCtx, cfg: { offlineAfterMs: number; heartbeatIntervalMs: number }) {
  const nodes = rows<NodeRow>(
    await ctx.db.execute(sql`
      SELECT id, name, status, last_metrics, risk_state,
             extract(epoch FROM now() - last_heartbeat_at)::float8 AS heartbeat_age_sec
        FROM storage_nodes
       WHERE status <> 'OFFLINE' AND last_metrics IS NOT NULL`),
  );
  if (!nodes.length) return;

  const history = rows<{ node_id: string; ts: Date; disk: number; uptime: number }>(
    await ctx.db.execute(sql`
      SELECT node_id, ts, disk_used_pct AS disk, uptime_sec AS uptime FROM node_metrics
       WHERE ts > now() - interval '30 minutes' ORDER BY ts`),
  );
  const outages = rows<{ id: string; n: number }>(
    await ctx.db.execute(sql`
      SELECT resource_id AS id, count(*)::int AS n FROM audit_logs
       WHERE action = 'node.offline' AND created_at > now() - interval '1 hour' GROUP BY 1`),
  );
  const replicaHealth = rows<{ node_id: string; total: number; bad: number }>(
    await ctx.db.execute(sql`
      SELECT r.node_id, count(*)::int AS total, count(*) FILTER (WHERE r.state IN ('CORRUPT', 'MISSING'))::int AS bad
        FROM replicas r JOIN object_versions v ON v.id = r.version_id
       WHERE v.state = 'ACTIVE' GROUP BY r.node_id`),
  );
  const failures = rows<{ name: string; n: number }>(
    await ctx.db.execute(sql`
      SELECT metadata->>'node' AS name, count(*)::int AS n FROM audit_logs
       WHERE action = 'object.integrity_failure' AND created_at > now() - interval '24 hours' GROUP BY 1`),
  );

  for (const n of nodes) {
    const m = n.last_metrics!;
    const prev = n.risk_state ?? {};
    const state = {
      latencyP95: ewma(prev.latencyP95, m.latencyMsP95, ALPHA),
      probeMs: ewma(prev.probeMs, m.probeMs ?? 0, ALPHA),
      errorRate: ewma(prev.errorRate, m.errorRate, ALPHA),
      cpu: ewma(prev.cpu, m.cpuPct, ALPHA),
      mem: ewma(prev.mem, m.memPct, ALPHA),
    };

    const samples = history.filter((h) => h.node_id === n.id);
    // disk fill rate (percentage points per hour) from the last 30 min plus the live value
    const pts = samples.map((h) => ({ x: new Date(h.ts).getTime() / 3_600_000, y: Number(h.disk) }));
    pts.push({ x: Date.now() / 3_600_000, y: m.diskUsedPct });
    // A fill-rate forecast needs a real trend: >= 5 samples over >= 10 minutes, on a disk that is
    // already half full. (An upload burst into an empty disk is not "full in 2 hours".)
    const spanH = pts.length ? pts[pts.length - 1]!.x - pts[0]!.x : 0;
    const rate = pts.length >= 5 && spanH >= 10 / 60 && m.diskUsedPct >= 50 ? slope(pts) : null;
    const eta = rate !== null && rate > 0.5 ? Math.max(0, (100 - m.diskUsedPct) / rate) : null;
    // process restarts: uptime going backwards between consecutive samples
    const uptimes = [...samples.map((h) => Number(h.uptime)), m.uptimeSec].filter((u) => u > 0);
    let restarts = 0;
    for (let i = 1; i < uptimes.length; i++) if (uptimes[i]! < uptimes[i - 1]!) restarts++;

    const rh = replicaHealth.find((r) => r.node_id === n.id);
    const inputs: RiskInputs = {
      diskUsedPct: m.diskUsedPct,
      diskFullEtaHours: eta,
      latencyP95Ms: state.latencyP95,
      probeMs: state.probeMs,
      errorRate: state.errorRate,
      heartbeatAgeSec: n.heartbeat_age_sec ?? 0,
      heartbeatIntervalSec: cfg.heartbeatIntervalMs / 1000,
      offlineAfterSec: cfg.offlineAfterMs / 1000,
      // an outage usually *is* a restart: count incidents once, not twice
      flapsLastHour: Math.max(outages.find((o) => o.id === n.id)?.n ?? 0, restarts),
      corruptRatio: rh && rh.total >= 20 ? rh.bad / rh.total : 0,
      integrityFailures24h: failures.find((f) => f.name === n.name)?.n ?? 0,
      cpuPct: state.cpu,
      memPct: state.mem,
    };
    const risk = scoreRisk(inputs);
    const next = nextRiskStatus(n.status, risk.score);
    const factors = {
      signals: risk.signals,
      contributions: risk.contributions,
      top: risk.top,
      diskFullEtaHours: eta === null ? null : Math.round(eta * 10) / 10,
      inputs: {
        diskUsedPct: m.diskUsedPct,
        probeMs: Math.round(state.probeMs * 100) / 100,
        latencyP95Ms: Math.round(state.latencyP95 * 100) / 100,
        errorRate: Math.round(state.errorRate * 10_000) / 10_000,
        flapsLastHour: inputs.flapsLastHour,
        corruptRatio: Math.round(inputs.corruptRatio * 10_000) / 10_000,
        integrityFailures24h: inputs.integrityFailures24h,
        cpuPct: Math.round(state.cpu * 10) / 10,
        memPct: Math.round(state.mem * 10) / 10,
      },
    };

    // the status only changes if nobody else (sweeper, heartbeat, admin) changed it meanwhile
    const changed = rows<{ id: string }>(
      await ctx.db.execute(sql`
        UPDATE storage_nodes
           SET risk_score = ${risk.score}, risk_factors = ${JSON.stringify(factors)}::jsonb,
               risk_state = ${JSON.stringify(state)}::jsonb, risk_updated_at = now(),
               status = CASE WHEN status = ${n.status} THEN ${next} ELSE status END,
               status_changed_at = CASE WHEN status = ${n.status} AND ${next} <> ${n.status} THEN now() ELSE status_changed_at END
         WHERE id = ${n.id}
        RETURNING CASE WHEN status <> ${n.status} THEN id END AS id`),
    ).filter((r) => r.id);

    void publish(ctx.redis, 'node.risk', { name: n.name, score: risk.score, status: changed.length ? next : n.status, top: risk.top });
    if (changed.length && next !== n.status) {
      const action = n.status !== 'HEALTHY' && next === 'HEALTHY' ? 'node.risk_cleared' : TRANSITION_ACTION[next] ?? 'node.status';
      ctx.log.warn({ node: n.name, from: n.status, to: next, score: risk.score, top: risk.top }, 'node risk status changed');
      await systemAudit(ctx, 'risk-scorer', action, { type: 'node', id: n.id }, {
        name: n.name,
        from: n.status,
        to: next,
        score: risk.score,
        top: risk.top,
        contributions: risk.contributions,
      });
      void publish(ctx.redis, 'node.status', { name: n.name, status: next, score: risk.score });
    }
  }
}
