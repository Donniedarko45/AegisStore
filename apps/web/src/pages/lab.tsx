import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bug, FlaskConical, HardDrive, RotateCcw, ShieldAlert, Zap } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { RISK_THRESHOLDS } from '@aegis/shared/web';
import { Button } from '../components/ui/button';
import { Segmented, SliderField, SwitchField } from '../components/ui/overlays';
import { Badge, Card, CardHeader, EmptyState, ErrorNote, NodeStatus, PageHeader, RelativeTime, Skeleton, type Tone } from '../components/ui/primitives';
import { Spinner } from '../components/ui/spinner';
import { http, type ChaosState, type SimRun, type SimRunDetail, type SimulationState } from '../lib/api';
import { cx, formatNumber, humanizeAction } from '../lib/format';

const CALM: ChaosState = { offline: false, latencyMs: 0, errorRate: 0, diskFillPct: 0 };
const isCalm = (c: ChaosState | null) => !c || (!c.offline && !c.latencyMs && !c.errorRate && !c.diskFillPct);

// ------------------------------------------------------------------------- fault injection
function NodeFaults({ node }: { node: SimulationState['nodes'][number] }) {
  const qc = useQueryClient();
  // local copy while dragging; the server state wins whenever it changes
  const [draft, setDraft] = useState<ChaosState>(node.chaos ?? CALM);
  useEffect(() => setDraft(node.chaos ?? CALM), [node.chaos]);
  const apply = useMutation({
    mutationFn: (patch: Partial<ChaosState>) => http.post<{ chaos: ChaosState }>(`/api/simulation/nodes/${node.id}/chaos`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['simulation'] });
      void qc.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (e) => {
      setDraft(node.chaos ?? CALM);
      toast.error(e instanceof Error ? e.message : 'Fault injection failed');
    },
  });
  const set = (patch: Partial<ChaosState>) => setDraft((d) => ({ ...d, ...patch }));
  const commit = (patch: Partial<ChaosState>) => {
    set(patch);
    apply.mutate(patch);
  };
  const band: Tone = node.riskScore >= RISK_THRESHOLDS.highRisk ? 'bad' : node.riskScore >= RISK_THRESHOLDS.warning ? 'warn' : 'good';
  const active = !isCalm(node.chaos);

  return (
    <Card className={cx('p-5', active && 'shadow-[0_0_0_1px_var(--warn)]')}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <HardDrive className="size-4 shrink-0 text-fg-3" />
          <span className="truncate font-medium">{node.name}</span>
          {apply.isPending && <Spinner className="size-3.5 text-fg-3" />}
        </div>
        <NodeStatus status={node.status} />
      </div>
      <p className="mt-1.5 flex items-center gap-2 text-xs text-fg-2">
        Risk <span className={cx('font-medium tabular-nums', band === 'bad' ? 'text-bad-text' : band === 'warn' ? 'text-warn-text' : 'text-fg')}>{(node.riskScore * 100).toFixed(0)}</span>
        {active ? <Badge tone="warn">Fault active</Badge> : <span className="text-fg-3">no faults</span>}
        {!node.reachable && <Badge tone="bad">unreachable</Badge>}
      </p>
      <div className="mt-5 space-y-5">
        <SwitchField
          checked={draft.offline}
          onChange={(v) => commit({ offline: v })}
          disabled={!node.reachable}
          label="Crash node"
          description="Stops heartbeats and refuses all I/O: OFFLINE in ~15 s, then self-healing re-replicates after a 60 s grace."
        />
        <SliderField label="Added latency" value={draft.latencyMs} min={0} max={1500} step={50} format={(v) => (v ? `${v} ms` : 'off')} onChange={(v) => set({ latencyMs: v })} onCommit={(v) => commit({ latencyMs: v })} disabled={!node.reachable} />
        <SliderField label="I/O error rate" value={Math.round(draft.errorRate * 100)} min={0} max={60} step={5} format={(v) => (v ? `${v}%` : 'off')} onChange={(v) => set({ errorRate: v / 100 })} onCommit={(v) => commit({ errorRate: v / 100 })} disabled={!node.reachable} />
        <SliderField label="Disk fill" value={draft.diskFillPct} min={0} max={100} step={5} format={(v) => (v ? `${v}%` : 'real')} onChange={(v) => set({ diskFillPct: v })} onCommit={(v) => commit({ diskFillPct: v })} disabled={!node.reachable} />
      </div>
      {active && (
        <Button size="sm" variant="ghost" className="mt-4" loading={apply.isPending} onClick={() => commit(CALM)}>
          <RotateCcw /> Clear faults
        </Button>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------------ scenarios
function Scenario({ icon, title, description, children, action }: { icon: ReactNode; title: string; description: string; children?: ReactNode; action: ReactNode }) {
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-surface-2 text-fg-2 [&_svg]:size-4">{icon}</span>
        <h3 className="font-medium">{title}</h3>
      </div>
      <p className="mt-2 flex-1 text-[13px] text-fg-2">{description}</p>
      {children && <div className="mt-4 space-y-4">{children}</div>}
      <div className="mt-5">{action}</div>
    </Card>
  );
}

function Scenarios({ onStarted }: { onStarted: (runId: string) => void }) {
  const qc = useQueryClient();
  const [reads, setReads] = useState(300);
  const [files, setFiles] = useState(30);
  const [autoLock, setAutoLock] = useState(true);
  const done = (msg: string, desc?: string) => (r: { runId: string }) => {
    void qc.invalidateQueries({ queryKey: ['simulation'] });
    onStarted(r.runId);
    toast.success(msg, { description: desc });
  };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not start');
  const corrupt = useMutation({ mutationFn: () => http.post<{ runId: string; bucket: string; key: string; node: string }>('/api/simulation/corrupt', {}), onSuccess: (r) => done('Bit rot injected', `${r.bucket}/${r.key} on ${r.node}`)(r), onError: fail });
  const traffic = useMutation({ mutationFn: () => http.post<{ runId: string }>('/api/simulation/traffic', { objects: 12, reads, hotKeys: 2, sizeKb: 64 }), onSuccess: done('Traffic started', 'Writing 12 objects into sim-traffic, then reading two of them hard.'), onError: fail });
  const ransom = useMutation({ mutationFn: () => http.post<{ runId: string; bucket: string }>('/api/simulation/ransomware', { files, autoLock }), onSuccess: (r) => done('Ransomware drill started', `A stolen key is encrypting ${r.bucket}.`)(r), onError: fail });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Scenario
        icon={<Bug />}
        title="Bit rot"
        description="Flips 16 bytes inside one replica on disk, then asks the scrubber to look. Expect: detected as corrupt, rewritten in place from a healthy copy, risk score of that node rises."
        action={<Button className="w-full" loading={corrupt.isPending} onClick={() => corrupt.mutate()}><Bug /> Corrupt a replica</Button>}
      />
      <Scenario
        icon={<Activity />}
        title="Traffic burst"
        description="Writes 12 objects, then reads two of them heavily. Expect: both promoted to HOT within 30 s and given a third replica, reads spread across all three."
        action={<Button className="w-full" loading={traffic.isPending} onClick={() => traffic.mutate()}><Zap /> Generate traffic</Button>}
      >
        <Segmented size="sm" label="Reads" value={String(reads)} onChange={(v) => setReads(Number(v))} options={[{ value: '100', label: '100 reads' }, { value: '300', label: '300' }, { value: '1000', label: '1,000' }]} />
      </Scenario>
      <Scenario
        icon={<ShieldAlert />}
        title="Ransomware drill"
        description="A stolen API key fills a fresh bucket with invoices, then encrypts them in place and drops .locked copies. Expect: CRITICAL alert, pre-attack versions protected, bucket locked mid-attack, one-click recovery."
        action={<Button variant="primary" className="w-full" loading={ransom.isPending} onClick={() => ransom.mutate()}><ShieldAlert /> Run drill</Button>}
      >
        <Segmented size="sm" label="Files" value={String(files)} onChange={(v) => setFiles(Number(v))} options={[{ value: '15', label: '15 files' }, { value: '30', label: '30' }, { value: '60', label: '60' }]} />
        <SwitchField checked={autoLock} onChange={setAutoLock} label="Bucket opted in to auto-lock" description="Locks the bucket the moment a high-severity attack is detected." />
      </Scenario>
    </div>
  );
}

// ------------------------------------------------------------------------------- timeline
type Phase = 'injected' | 'detected' | 'responded';
const phaseOf = (action: string, meta: Record<string, unknown>): Phase => {
  if (action.startsWith('simulation.')) return 'injected';
  if (['replica.repaired', 'replica.trimmed', 'node.risk_cleared', 'node.online', 'bucket.lock', 'security.recover', 'security.contain'].includes(action)) return 'responded';
  if (action === 'object.class_changed') return meta.to === 'HOT' ? 'detected' : 'responded';
  return 'detected';
};
const PHASE: Record<Phase, { label: string; tone: Tone }> = {
  injected: { label: 'Injected', tone: 'neutral' },
  detected: { label: 'Detected', tone: 'warn' },
  responded: { label: 'Healed', tone: 'good' },
};
const KIND_LABEL: Record<SimRun['kind'], string> = { CHAOS: 'Node faults', CORRUPT: 'Bit rot', TRAFFIC: 'Traffic burst', RANSOMWARE: 'Ransomware drill' };

const describeEvent = (e: SimRunDetail['timeline'][number]) => {
  const m = e.metadata;
  const s = (k: string) => (typeof m[k] === 'string' || typeof m[k] === 'number' ? String(m[k]) : '');
  switch (e.action) {
    case 'simulation.chaos':
      return `${s('node')}: ${[m.offline && 'crashed', Number(m.latencyMs) > 0 && `+${s('latencyMs')} ms`, Number(m.errorRate) > 0 && `${Math.round(Number(m.errorRate) * 100)}% errors`, Number(m.diskFillPct) > 0 && `disk ${s('diskFillPct')}%`].filter(Boolean).join(', ') || 'faults changed'}`;
    case 'node.warning':
    case 'node.high_risk':
    case 'node.risk_cleared':
      return `${s('name')} → ${s('to').toLowerCase().replace('_', ' ')} (risk ${Math.round(Number(m.score) * 100)})`;
    case 'node.offline':
      return `${s('name')} missed heartbeats → offline`;
    case 'node.online':
      return `${s('name')} back online`;
    case 'replica.repaired':
      return `${s('key')}: ${s('from')} → ${s('to')}${s('reason') ? ` (${s('reason')})` : ''}`;
    case 'replica.trimmed':
      return `${s('key')}: extra copy removed from ${s('node')}`;
    case 'object.integrity_failure':
      return `${s('key')} on ${s('node')}: checksum mismatch`;
    case 'object.class_changed':
      return `${s('key')}: ${s('from')} → ${s('to')} (${s('reads24h')} reads/24 h)`;
    case 'security.alert':
      return `${s('severity')} ${String(s('kind')).toLowerCase().replace('_', ' ')} · ${s('protectedVersions')} versions protected${m.bucketLocked ? ' · bucket locked' : ''}`;
    default:
      return s('key') || s('bucket') || s('name') || '';
  }
};

function RunTimeline({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['simulation', 'run', id],
    queryFn: () => http.get<SimRunDetail>(`/api/simulation/runs/${id}`),
    refetchInterval: 3000,
    placeholderData: keepPreviousData,
  });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data!;
  const t0 = Date.parse(d.run.startedAt);
  const since = (iso: string) => {
    const s = Math.max(0, (Date.parse(iso) - t0) / 1000);
    return s < 60 ? `+${s.toFixed(1)} s` : `+${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
  };
  const first = (p: Phase) => d.timeline.find((e) => phaseOf(e.action, e.metadata) === p);
  const det = first('detected');
  const heal = first('responded');
  const summary = d.run.summary as Record<string, number | string[]> | null;
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Time to detect', det ? since(det.at) : '—'],
          ['Time to heal', heal ? since(heal.at) : '—'],
          ['Writes / reads', `${formatNumber(d.counts.uploads)} / ${formatNumber(d.counts.downloads)}`],
          ['Status', d.run.status === 'RUNNING' ? 'Running' : d.run.status === 'FAILED' ? 'Failed' : 'Done'],
        ].map(([l, v]) => (
          <div key={l} className="rounded-lg p-3 shadow-[inset_0_0_0_1px_var(--border)]">
            <p className="text-xs text-fg-2">{l}</p>
            <p className="mt-0.5 font-semibold tabular-nums">{v}</p>
          </div>
        ))}
      </div>
      {summary && typeof summary.blocked === 'number' && summary.blocked > 0 && (
        <p className="mt-3 text-[13px] text-good-text">The lock refused {summary.blocked} of the attacker's writes while the attack was still running.</p>
      )}
      {d.timeline.length === 0 ? (
        <p className="mt-4 text-[13px] text-fg-3">{d.run.status === 'RUNNING' ? 'Waiting for the cluster to react…' : 'No events recorded in this run’s scope.'}</p>
      ) : (
        <ol className="relative mt-4 space-y-0.5 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-line">
          {d.timeline.map((e, i) => {
            const ph = phaseOf(e.action, e.metadata);
            return (
              <li key={`${e.at}-${i}`} className="enter relative flex items-start gap-3 py-1.5 pl-0 text-[13px]">
                <span className={cx('relative z-[1] mt-1.5 size-[11px] shrink-0 rounded-full shadow-[0_0_0_3px_var(--surface)]', ph === 'injected' ? 'bg-fg-3' : ph === 'detected' ? 'bg-warn' : 'bg-good')} />
                <span className="w-16 shrink-0 text-xs text-fg-3 tabular-nums">{since(e.at)}</span>
                <div className="min-w-0 flex-1">
                  <span className="mr-2 font-medium">{humanizeAction(e.action)}</span>
                  <span className="text-fg-2">{describeEvent(e)}</span>
                </div>
                <Badge tone={PHASE[ph].tone}>{PHASE[ph].label}</Badge>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------------- page
export function LabPage() {
  const qc = useQueryClient();
  const sim = useQuery({ queryKey: ['simulation'], queryFn: () => http.get<SimulationState>('/api/simulation'), refetchInterval: 5000 });
  const [selected, setSelected] = useState<string | null>(null);
  const runs = sim.data?.runs ?? [];
  const current = selected ?? runs[0]?.id ?? null;
  const anyFault = sim.data?.nodes.some((n) => !isCalm(n.chaos));
  const reset = useMutation({
    mutationFn: () => http.post('/api/simulation/reset'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['simulation'] });
      toast.success('All faults cleared');
    },
  });

  return (
    <>
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-1.5"><FlaskConical className="size-3.5" /> Administrators only</span>}
        title="Simulation Lab"
        description="Break the cluster on purpose and watch it defend itself. Faults go through each node's authenticated chaos endpoint; traffic and attacks go through the real API."
        actions={anyFault && <Button loading={reset.isPending} onClick={() => reset.mutate()}><RotateCcw /> Clear all faults</Button>}
      />
      {sim.error ? (
        <ErrorNote error={sim.error} />
      ) : (
        <>
          <h2 className="mb-3 text-sm font-medium">Node faults</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sim.data ? sim.data.nodes.map((n) => <NodeFaults key={n.id} node={n} />) : [0, 1, 2].map((i) => <Skeleton key={i} className="h-[380px] rounded-xl" />)}
          </div>
          <p className="mt-3 text-xs text-fg-3">
            Watch the effect on <Link to="/nodes" className="underline-offset-2 hover:underline">Nodes</Link> (risk breakdown, self-healing) while a fault is active.
          </p>

          <h2 className="mt-8 mb-3 text-sm font-medium">Scenarios</h2>
          <Scenarios onStarted={setSelected} />

          <Card className="mt-8">
            <CardHeader title="Runs" description="Each run's timeline is the audit trail within its scope: injected, then detected, then healed." />
            {runs.length === 0 ? (
              <EmptyState icon={<FlaskConical />} title="No runs yet" description="Inject a fault or start a scenario above." />
            ) : (
              <div className="grid grid-cols-1 border-t border-line lg:grid-cols-[300px_1fr]">
                <ul className="max-h-[520px] divide-y divide-line overflow-y-auto lg:border-r lg:border-line">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(r.id)}
                        aria-current={current === r.id}
                        className={cx('flex w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-150', current === r.id ? 'bg-surface-2' : 'hover:bg-surface-2/60')}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium">{KIND_LABEL[r.kind]}</p>
                          <p className="truncate text-xs text-fg-3">{[...(r.scope.nodes ?? []), ...(r.scope.buckets ?? [])].join(', ')}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {r.status === 'RUNNING' ? <Badge tone="info">Running</Badge> : r.status === 'FAILED' ? <Badge tone="bad">Failed</Badge> : <Badge tone="good">Done</Badge>}
                          <RelativeTime iso={r.startedAt} className="text-[11px] text-fg-3" />
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="min-w-0 p-5">{current && <RunTimeline key={current} id={current} />}</div>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
