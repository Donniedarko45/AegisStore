import { RISK_FACTORS, RISK_LABELS, RISK_THRESHOLDS, type NodeRiskDto, type RiskFactor } from '@aegis/shared/web';
import { cx } from '../../lib/format';

const zoneOf = (score: number) => (score >= RISK_THRESHOLDS.highRisk ? 'bad' : score >= RISK_THRESHOLDS.warning ? 'warn' : 'good');

/**
 * Semicircle gauge: three zones (healthy / warning / high risk) at the real thresholds, and a
 * needle for the score. The score is functional data the user reads, so only the needle moves
 * (a transform, 300 ms ease-out) - the arc itself never animates.
 */
export function RiskGauge({ score, size = 132, label = true }: { score: number; size?: number; label?: boolean }) {
  const r = 50;
  const cx0 = 60;
  const cy0 = 58;
  const pt = (t: number) => {
    const a = Math.PI * (1 - t);
    return [cx0 + r * Math.cos(a), cy0 - r * Math.sin(a)] as const;
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = pt(from);
    const [x2, y2] = pt(to);
    return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 0 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
  };
  const gap = 0.012;
  const s = Math.min(1, Math.max(0, score));
  const zone = zoneOf(s);
  return (
    <div style={{ width: size }}>
      <svg viewBox="0 0 120 66" className="w-full overflow-visible" role="img" aria-label={`Risk score ${(s * 100).toFixed(0)} of 100`}>
        <path d={arc(0, RISK_THRESHOLDS.warning - gap)} stroke="var(--good)" strokeOpacity={0.35} strokeWidth={9} fill="none" strokeLinecap="butt" />
        <path d={arc(RISK_THRESHOLDS.warning + gap, RISK_THRESHOLDS.highRisk - gap)} stroke="var(--warn)" strokeOpacity={0.4} strokeWidth={9} fill="none" />
        <path d={arc(RISK_THRESHOLDS.highRisk + gap, 1)} stroke="var(--bad)" strokeOpacity={0.4} strokeWidth={9} fill="none" />
        <g style={{ transform: `rotate(${s * 180}deg)`, transformOrigin: `${cx0}px ${cy0}px`, transition: 'transform 300ms var(--ease-out)' }}>
          <line x1={cx0 - r + 14} y1={cy0} x2={cx0 - r + 2} y2={cy0} stroke="var(--fg)" strokeWidth={2.5} strokeLinecap="round" />
        </g>
      </svg>
      {label && (
        <div className="-mt-1 text-center">
          <span className={cx('text-xl font-semibold tabular-nums', zone === 'bad' ? 'text-bad-text' : zone === 'warn' ? 'text-warn-text' : 'text-fg')}>{(s * 100).toFixed(0)}</span>
          <span className="text-xs text-fg-3"> / 100</span>
        </div>
      )}
    </div>
  );
}

const describe = (f: RiskFactor, inputs: Record<string, number>, eta: number | null) => {
  const n = (k: string, d = 1) => (typeof inputs[k] === 'number' ? inputs[k]!.toFixed(d) : '—');
  switch (f) {
    case 'disk':
      return `${n('diskUsedPct')}% used${eta !== null ? ` · full in ~${eta < 1 ? '<1' : eta.toFixed(0)} h` : ''}`;
    case 'latency':
      return `probe ${n('probeMs', 1)} ms · p95 ${n('latencyP95Ms', 0)} ms`;
    case 'errors':
      return `${((inputs.errorRate ?? 0) * 100).toFixed(1)}% of I/O failing`;
    case 'heartbeat':
      return `${Number.isInteger(inputs.flapsLastHour ?? 0) ? (inputs.flapsLastHour ?? 0) : n('flapsLastHour', 1)} outages / restarts in the last hour`;
    case 'corruption':
      return `${inputs.integrityFailures24h ?? 0} bad copies found in 24 h`;
    case 'saturation':
      return `CPU ${n('cpuPct', 0)}% · memory ${n('memPct', 0)}%`;
  }
};

/**
 * Why a node has its score: each factor's own risk (what it alone would make the node), ranked.
 * Bars share one hue; the top factor is marked by weight and a label, not by a second colour.
 */
export function RiskBreakdown({ risk, compact }: { risk: NodeRiskDto; compact?: boolean }) {
  const rows = RISK_FACTORS.map((f) => ({ f, c: risk.contributions[f] ?? 0 })).sort((a, b) => b.c - a.c);
  return (
    <ul className="space-y-2.5">
      {(compact ? rows.slice(0, 3) : rows).map(({ f, c }) => (
        <li key={f}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className={cx(f === risk.top ? 'font-medium text-fg' : 'text-fg-2')}>
              {RISK_LABELS[f]}
              {f === risk.top && c > 0.01 && <span className="ml-1.5 text-xs text-fg-3">main factor</span>}
            </span>
            <span className="shrink-0 font-medium tabular-nums">{(c * 100).toFixed(0)}</span>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-[var(--series-1)]" style={{ transform: `scaleX(${Math.max(0, Math.min(1, c))})` }} />
            {/* the warning and high-risk thresholds, so a long bar reads in context */}
            <span aria-hidden className="absolute inset-y-0 w-px bg-surface" style={{ left: `${RISK_THRESHOLDS.warning * 100}%` }} />
            <span aria-hidden className="absolute inset-y-0 w-px bg-surface" style={{ left: `${RISK_THRESHOLDS.highRisk * 100}%` }} />
          </div>
          {!compact && <p className="mt-1 text-xs text-fg-3">{describe(f, risk.inputs, risk.diskFullEtaHours)}</p>}
        </li>
      ))}
    </ul>
  );
}
