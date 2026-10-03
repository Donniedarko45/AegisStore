import type { NodeStatus } from './constants';

/**
 * Predictive node-failure risk (architecture §9.1).
 *
 * Each signal is normalised to 0..1 ("how bad is this signal"), multiplied by its impact ("how
 * risky can this signal alone make the node"), and the per-signal risks are combined with a
 * noisy-OR:   risk = 1 - Π(1 - impact_i · signal_i)
 *
 * A noisy-OR (instead of a weighted average) means one strong signal is enough to reach
 * HIGH_RISK - a node with a 20 % error rate is risky no matter how idle its CPU is - while
 * several moderate signals still add up. Every contribution is reported so the UI can explain
 * the score.
 */
export const RISK_FACTORS = ['disk', 'latency', 'errors', 'heartbeat', 'corruption', 'saturation'] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number];

export const RISK_IMPACT: Record<RiskFactor, number> = {
  disk: 0.8,
  latency: 0.75,
  errors: 0.9,
  heartbeat: 0.7,
  corruption: 0.85,
  saturation: 0.35,
};

export const RISK_LABELS: Record<RiskFactor, string> = {
  disk: 'Disk fill',
  latency: 'I/O latency',
  errors: 'Error rate',
  heartbeat: 'Heartbeat stability',
  corruption: 'Corrupt replicas',
  saturation: 'CPU / memory',
};

export const RISK_THRESHOLDS = {
  warning: 0.4,
  highRisk: 0.7,
  /** hysteresis: leave WARNING below this */
  warningClear: 0.3,
  /** hysteresis: leave HIGH_RISK below this */
  highRiskClear: 0.6,
} as const;

/** Raw (smoothed) observations about one node. */
export interface RiskInputs {
  diskUsedPct: number;
  /** hours until the disk is full at the current fill rate; null when not filling */
  diskFullEtaHours: number | null;
  latencyP95Ms: number;
  probeMs: number;
  /** fraction 0..1 */
  errorRate: number;
  /** seconds since the last heartbeat */
  heartbeatAgeSec: number;
  heartbeatIntervalSec: number;
  offlineAfterSec: number;
  /** OFFLINE incidents and process restarts in the last hour */
  flapsLastHour: number;
  /** CORRUPT or MISSING replicas / all replicas of live versions on the node (0 below 20 replicas) */
  corruptRatio: number;
  /** integrity failures attributed to this node in the last 24 h */
  integrityFailures24h: number;
  cpuPct: number;
  memPct: number;
}

export interface RiskResult {
  score: number;
  /** normalised 0..1 signal per factor */
  signals: Record<RiskFactor, number>;
  /** impact · signal per factor (what the factor alone would make the risk) */
  contributions: Record<RiskFactor, number>;
  /** the factor contributing most, or null when the node is clean */
  top: RiskFactor | null;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
/** 0 at or below `lo`, 1 at or above `hi`, linear in between */
export const ramp = (v: number, lo: number, hi: number) => clamp01((v - lo) / (hi - lo));

export function riskSignals(x: RiskInputs): Record<RiskFactor, number> {
  const etaSignal = x.diskFullEtaHours === null ? 0 : x.diskFullEtaHours < 1 ? 1 : x.diskFullEtaHours < 6 ? 0.7 : x.diskFullEtaHours < 24 ? 0.4 : 0;
  const lateBeat = ramp(x.heartbeatAgeSec, x.heartbeatIntervalSec * 2, x.offlineAfterSec);
  return {
    disk: Math.max(ramp(x.diskUsedPct, 75, 97), etaSignal),
    latency: Math.max(ramp(x.probeMs, 25, 300), ramp(x.latencyP95Ms, 150, 1500)),
    errors: ramp(x.errorRate, 0.005, 0.15),
    heartbeat: Math.max(lateBeat, clamp01(x.flapsLastHour * 0.35)),
    // one detected bad copy is an incident (and self-healing fixes it); repeated ones on the same
    // node within a day are a sign of failing media
    corruption: Math.max(ramp(x.corruptRatio, 0.02, 0.25), x.integrityFailures24h >= 4 ? 1 : x.integrityFailures24h * 0.3),
    saturation: ramp(Math.max(x.cpuPct, x.memPct), 85, 99),
  };
}

export function scoreRisk(x: RiskInputs): RiskResult {
  const signals = riskSignals(x);
  const contributions = {} as Record<RiskFactor, number>;
  let keep = 1;
  let top: RiskFactor | null = null;
  for (const f of RISK_FACTORS) {
    const c = RISK_IMPACT[f] * signals[f];
    contributions[f] = Math.round(c * 1000) / 1000;
    keep *= 1 - c;
    if (c > 0.01 && (top === null || c > contributions[top])) top = f;
  }
  return { score: Math.round((1 - keep) * 1000) / 1000, signals, contributions, top };
}

/**
 * Next health status from the current one and a fresh score, with hysteresis so a node hovering
 * around a threshold does not flap. OFFLINE and DRAINING are owned by other components
 * (the health sweeper and the administrator) and are never changed here.
 */
export function nextRiskStatus(current: NodeStatus, score: number): NodeStatus {
  if (current === 'OFFLINE' || current === 'DRAINING') return current;
  const t = RISK_THRESHOLDS;
  if (current === 'HIGH_RISK') return score >= t.highRiskClear ? 'HIGH_RISK' : score >= t.warningClear ? 'WARNING' : 'HEALTHY';
  if (score >= t.highRisk) return 'HIGH_RISK';
  if (current === 'WARNING') return score >= t.warningClear ? 'WARNING' : 'HEALTHY';
  return score >= t.warning ? 'WARNING' : 'HEALTHY';
}

/** Exponentially weighted moving average step. */
export const ewma = (prev: number | undefined, next: number, alpha: number) =>
  prev === undefined || !Number.isFinite(prev) ? next : alpha * next + (1 - alpha) * prev;

/** Least-squares slope (units of y per unit of x). Null with fewer than 3 points. */
export function slope(points: { x: number; y: number }[]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

/** Statuses that accept new writes. WARNING still does; HIGH_RISK is being evacuated. */
export const WRITABLE_STATUSES: readonly NodeStatus[] = ['HEALTHY', 'WARNING'];
/** Statuses whose replicas count toward an object's durability target. */
export const DURABLE_STATUSES: readonly NodeStatus[] = ['HEALTHY', 'WARNING'];
