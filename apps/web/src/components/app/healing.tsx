import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Hourglass, ScanSearch, Scissors, ShieldAlert, Wrench } from 'lucide-react';
import { http, type HealingJob, type HealingSummary } from '../../lib/api';
import { cx, formatBytes, formatNumber, relativeTime } from '../../lib/format';
import { usePollInterval } from '../../lib/queries';
import { Spinner } from '../ui/spinner';
import { Badge, Card, CardHeader, Meter, Skeleton, type Tone } from '../ui/primitives';

export function useHealing() {
  const refetchInterval = usePollInterval(5000, 15_000);
  return useQuery({ queryKey: ['healing', 'summary'], queryFn: () => http.get<HealingSummary>('/api/healing'), refetchInterval, placeholderData: keepPreviousData });
}

const TYPE: Record<HealingJob['type'], { label: string; icon: typeof Wrench }> = {
  REPAIR_REPLICA: { label: 'Repair', icon: Wrench },
  TRIM_REPLICA: { label: 'Trim', icon: Scissors },
  VERIFY_REPLICA: { label: 'Verify', icon: ScanSearch },
};
const STATUS: Record<HealingJob['status'], { label: string; tone: Tone }> = {
  QUEUED: { label: 'Queued', tone: 'neutral' },
  RUNNING: { label: 'Running', tone: 'info' },
  DONE: { label: 'Done', tone: 'good' },
  FAILED: { label: 'Failed', tone: 'bad' },
  CANCELLED: { label: 'Skipped', tone: 'neutral' },
};

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="truncate text-xs text-fg-2">{label}</p>
      <p className={cx('mt-0.5 text-lg font-semibold tabular-nums', tone === 'bad' ? 'text-bad-text' : tone === 'warn' ? 'text-warn-text' : 'text-fg')}>{value}</p>
      {sub && <p className="truncate text-xs text-fg-3">{sub}</p>}
    </div>
  );
}

export function JobRow({ j }: { j: HealingJob }) {
  const t = TYPE[j.type];
  const st = STATUS[j.status];
  const Icon = t.icon;
  const result = j.result as { from?: string; to?: string; state?: string } | null;
  return (
    <li className="flex items-start gap-3 px-5 py-2.5">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-2">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
          <span className="font-medium">{t.label}</span>
          <span className="min-w-0 truncate font-mono text-xs text-fg-2">
            {j.bucket}/{j.key}
          </span>
        </p>
        <p className="mt-0.5 truncate text-xs text-fg-3">
          {j.type === 'REPAIR_REPLICA' && result?.from ? `${result.from} → ${result.to}` : j.node ? `on ${j.node}` : ''}
          {j.reason && ` · ${j.reason}`}
          {j.status === 'DONE' && j.bytes > 0 && ` · ${formatBytes(j.bytes)}`}
          {j.status === 'DONE' && j.type === 'VERIFY_REPLICA' && result?.state && result.state !== 'HEALTHY' && ` · found ${result.state.toLowerCase()}`}
          {j.lastError && j.status !== 'DONE' && ` · ${j.lastError}`}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {j.status === 'RUNNING' ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
            <Spinner className="size-3" /> Running
          </span>
        ) : (
          <Badge tone={st.tone}>{st.label}</Badge>
        )}
        <span className="text-[11px] text-fg-3 tabular-nums">{relativeTime(j.finishedAt ?? j.startedAt ?? j.createdAt)}</span>
      </div>
    </li>
  );
}

/**
 * Self-healing at a glance: what the reconciler sees (desired vs actual replicas), the queue,
 * scrub coverage and the most recent jobs. Updated live from job events.
 */
export function HealingPanel({ limit = 12 }: { limit?: number }) {
  const summary = useHealing();
  const jobs = useQuery({
    queryKey: ['healing', 'jobs', limit],
    queryFn: () => http.get<{ items: HealingJob[] }>(`/api/healing/jobs?limit=${limit}`),
    refetchInterval: usePollInterval(5000, 15_000),
    placeholderData: keepPreviousData,
  });
  const s = summary.data;
  const rec = s?.reconciler;
  const coverage = s && s.scrub.replicas ? (s.scrub.verified7d / s.scrub.replicas) * 100 : 100;
  const settled = rec && rec.underReplicated === 0 && rec.overReplicated === 0 && (s?.queue.queued ?? 0) + (s?.queue.running ?? 0) === 0;

  return (
    <Card>
      <CardHeader
        title="Self-healing"
        description="The reconciler compares every object's replicas with its target every 10 seconds and repairs the difference."
        action={
          rec &&
          (settled ? (
            <Badge tone="good" icon>
              All objects at target
            </Badge>
          ) : (
            <Badge tone="warn" icon>
              {formatNumber(rec.underReplicated + rec.overReplicated)} need attention
            </Badge>
          ))
        }
      />
      {!s ? (
        <Skeleton className="mx-5 mb-5 h-40" />
      ) : (
        <>
          <div className="mx-5 grid grid-cols-2 divide-line overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_var(--border)] sm:grid-cols-4 sm:divide-x">
            <Tile label="Under-replicated" value={formatNumber(rec?.underReplicated ?? 0)} sub={rec?.waitingGrace ? `${rec.waitingGrace} in grace period` : 'below target'} tone={rec?.underReplicated ? 'warn' : undefined} />
            <Tile label="Cannot reach target" value={formatNumber(rec?.cannotReachTarget ?? 0)} sub={rec?.noSource ? `${rec.noSource} unreadable` : 'not enough nodes'} tone={rec?.noSource ? 'bad' : rec?.cannotReachTarget ? 'warn' : undefined} />
            <Tile label="Queue" value={`${s.queue.running} / ${s.queue.queued}`} sub="running / queued" />
            <Tile label="Healed in 24 h" value={formatNumber(s.queue.repaired24h)} sub={`${formatBytes(s.queue.bytesHealed24h)} copied · ${s.queue.trimmed24h} trimmed`} />
          </div>
          <div className="mx-5 mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
            <div className="flex min-w-56 flex-1 items-center gap-3">
              <span className="shrink-0 text-fg-2">Scrubbed in 7 days</span>
              <Meter value={coverage} tone="info" className="flex-1" label="Replicas re-verified in the last 7 days" />
              <span className="shrink-0 font-medium tabular-nums">{coverage.toFixed(0)}%</span>
            </div>
            <span className="inline-flex items-center gap-1.5 text-fg-2">
              {s.integrity.corrupt + s.integrity.missing > 0 ? <ShieldAlert className="size-4 text-bad-text" /> : <CheckCircle2 className="size-4 text-good-text" />}
              {s.integrity.corrupt} corrupt · {s.integrity.missing} missing
            </span>
            {rec && (
              <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                <Hourglass className="size-3.5" /> checked {relativeTime(rec.updatedAt ?? rec.at)}
              </span>
            )}
          </div>
          <div className="mt-4 border-t border-line">
            {jobs.data?.items.length ? (
              <ul className="max-h-[360px] divide-y divide-line overflow-y-auto">
                {jobs.data.items.map((j) => (
                  <JobRow key={j.id} j={j} />
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-[13px] text-fg-3">No repairs yet. Stop a node or corrupt a replica in the Simulation Lab to watch it heal.</p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
