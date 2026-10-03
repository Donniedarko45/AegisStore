import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Liveline } from 'liveline';
import { ArrowDownToLine, Clock, Cpu, Gauge, HardDrive, MemoryStick, Network, Search, Undo2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RISK_LABELS, RISK_THRESHOLDS } from '@aegis/shared/web';
import { HealingPanel } from '../components/app/healing';
import { RiskBreakdown, RiskGauge } from '../components/figures/risk';
import { useTheme } from '../lib/theme';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChartCard, entityColor, Legend, Sparkline, TimeSeries, timeTick, useHidden } from '../components/charts/chart-kit';
import { HashRingFigure, walkRing } from '../components/figures/hash-ring';
import { UptimeBars } from '../components/figures/uptime';
import { Button } from '../components/ui/button';
import { ConfirmDialog, Segmented, Sheet } from '../components/ui/overlays';
import { Badge, Card, CardHeader, ErrorNote, Input, Meter, NodeStatus, PageHeader, RelativeTime, Skeleton } from '../components/ui/primitives';
import { http, type NodeDetail, type NodeDto, type NodeMetricsSeries, type Range, type RingData, type RiskSeries, type UptimeData } from '../lib/api';
import { useLive, type LivePoint } from '../lib/live';
import { cx, formatBytes, formatDuration, plural } from '../lib/format';
import { useMe, useNodes } from '../lib/queries';
import { useCssColors } from '../lib/use-css-color';

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4'] as const;

/** Seed live series with recent stored samples so charts are never empty on arrival. */
function useSeededLive() {
  const live = useLive((s) => s.series);
  const seed = useQuery({ queryKey: ['node-metrics', '1h'], queryFn: () => http.get<NodeMetricsSeries>('/api/nodes/metrics?range=1h'), staleTime: 60_000 });
  return useMemo(() => {
    const out: Record<string, { time: number; p95: number; cpu: number; probe: number }[]> = {};
    for (const n of seed.data?.nodes ?? []) {
      out[n] = (seed.data?.latencyP95 ?? [])
        .filter((r) => typeof r[n] === 'number')
        .map((r) => ({ time: Date.parse(r.t) / 1000, p95: r[n] as number, cpu: Number(seed.data!.cpu.find((c) => c.t === r.t)?.[n] ?? 0), probe: Number(seed.data!.probe.find((c) => c.t === r.t)?.[n] ?? 0) }));
    }
    for (const [n, pts] of Object.entries(live)) {
      const seedPts = (out[n] ?? []).filter((p) => !pts.length || p.time < pts[0]!.time);
      out[n] = [...seedPts, ...pts.map((p: LivePoint) => ({ time: p.time, p95: p.p95, cpu: p.cpu, probe: p.probe }))];
    }
    return out;
  }, [live, seed.data]);
}

function NodeCard({ n, names, spark, onOpen }: { n: NodeDto; names: string[]; spark: number[]; onOpen: () => void }) {
  const usedPct = n.capacityBytes ? (n.usedBytes / n.capacityBytes) * 100 : 0;
  const offline = n.status === 'OFFLINE';
  const lastBeat = useLive((s) => s.lastBeat[n.name]);
  return (
    <button type="button" onClick={onOpen} className="pressable press-subtle block w-full rounded-xl text-left" aria-label={`Open ${n.name}`}>
      <Card className={cx('hover-raise h-full p-5', offline && 'shadow-[0_0_0_1px_var(--bad)]')}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg shadow-[inset_0_0_0_1px_var(--border)]" style={{ background: `color-mix(in srgb, ${entityColor(n.name, names)} 14%, transparent)` }}>
              <HardDrive className="size-4" style={{ color: entityColor(n.name, names) }} />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{n.name}</p>
              <p className="truncate font-mono text-xs text-fg-3">{n.baseUrl.replace(/^https?:\/\//, '')}</p>
            </div>
          </div>
          <NodeStatus status={n.status} />
        </div>
        <RiskLine n={n} />
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-xs text-fg-2 tabular-nums">
            <span>{formatBytes(n.usedBytes)} used</span>
            <span>{formatBytes(n.capacityBytes)}</span>
          </div>
          <Meter value={usedPct} label={`${n.name} disk usage`} />
        </div>
        <div className="mt-4">
          <p className="mb-1 text-xs text-fg-2">Disk I/O probe · live</p>
          <Sparkline values={spark.slice(-30)} height={34} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-4 text-[13px]">
          <Stat icon={<Gauge />} label="I/O probe" value={n.metrics?.probeMs !== undefined ? `${n.metrics.probeMs.toFixed(1)} ms` : '—'} />
          <Stat icon={<Cpu />} label="CPU" value={n.metrics ? `${n.metrics.cpuPct.toFixed(0)}%` : '—'} />
          <Stat icon={<MemoryStick />} label="Memory" value={n.metrics ? `${n.metrics.memPct.toFixed(0)}%` : '—'} />
          <Stat icon={<Network />} label="Ring" value={`${n.ringSharePct}%`} />
          <Stat icon={<Gauge />} label="Req p95" value={!n.metrics ? '—' : n.metrics.latencyMsP95 > 0 ? `${n.metrics.latencyMsP95.toFixed(1)} ms` : 'idle'} />
        </dl>
        <p className={cx('mt-3 flex items-center gap-1.5 text-xs', offline ? 'text-bad-text' : 'text-fg-3')}>
          <Clock className="size-3.5" /> Heartbeat {lastBeat ? <RelativeTime iso={new Date(lastBeat).toISOString()} /> : <RelativeTime iso={n.lastHeartbeatAt} />}
        </p>
      </Card>
    </button>
  );
}

/** Score, its band and the main reason, in one line (the full breakdown is in the node sheet). */
function RiskLine({ n }: { n: NodeDto }) {
  const score = n.riskScore;
  const band = score >= RISK_THRESHOLDS.highRisk ? 'bad' : score >= RISK_THRESHOLDS.warning ? 'warn' : 'good';
  const top = n.risk?.top;
  return (
    <div className="mt-4 flex items-center gap-3 text-xs">
      <span className="text-fg-2">Failure risk</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`Risk ${(score * 100).toFixed(0)} of 100`}>
        <div
          className={cx('absolute inset-y-0 left-0 w-full origin-left rounded-full', band === 'bad' ? 'bg-bad' : band === 'warn' ? 'bg-warn' : 'bg-good')}
          style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, score))})`, transition: 'transform 300ms var(--ease-out)' }}
        />
      </div>
      <span className="w-6 text-right font-medium tabular-nums">{(score * 100).toFixed(0)}</span>
      {top && score >= 0.1 ? <span className="max-w-28 truncate text-fg-3">{RISK_LABELS[top]}</span> : <span className="text-fg-3">no signals</span>}
      {n.draining && <Badge tone="info">Draining</Badge>}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-fg-3 [&_svg]:size-3.5">{icon}</span>
      <dt className="text-fg-2">{label}</dt>
      <dd className="ml-auto font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function LiveLatency({ names, seeded }: { names: string[]; seeded: ReturnType<typeof useSeededLive> }) {
  const { resolvedTheme } = useTheme();
  const colors = useCssColors(SERIES_VARS);
  const [metric, setMetric] = useState<'probe' | 'p95' | 'cpu'>('probe');
  const pick = (p: { probe: number; p95: number; cpu: number }) => (metric === 'probe' ? p.probe : metric === 'p95' ? p.p95 : p.cpu);
  const [windowSecs, setWindowSecs] = useState(300);
  const sorted = [...names].sort();
  const series = sorted
    .filter((n) => seeded[n]?.length)
    .map((n) => {
      const pts = seeded[n]!;
      return {
        id: n,
        label: n,
        color: colors[SERIES_VARS[sorted.indexOf(n) % 4]!],
        data: pts.map((p) => ({ time: p.time, value: pick(p) })),
        value: pick(pts[pts.length - 1]!),
      };
    });
  return (
    <Card>
      <CardHeader
        title="Live"
        description="Streamed from node heartbeats over SSE. Hover to scrub; click a node chip to hide it."
        action={<Segmented size="sm" label="Metric" value={metric} onChange={setMetric} options={[{ value: 'probe', label: 'Disk I/O' }, { value: 'p95', label: 'Request p95' }, { value: 'cpu', label: 'CPU' }]} />}
      />
      <div className="h-64 min-w-0 overflow-hidden px-3 pb-3">
        <Liveline
          data={[]}
          value={0}
          series={series}
          theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
          window={windowSecs}
          windows={[{ label: '1m', secs: 60 }, { label: '5m', secs: 300 }, { label: '15m', secs: 900 }]}
          onWindowChange={setWindowSecs}
          windowStyle="rounded"
          grid
          loading={series.length === 0}
          formatValue={(v) => (metric === 'cpu' ? `${v.toFixed(0)}%` : `${Math.max(0, v).toFixed(2)} ms`)}
          emptyText="Waiting for heartbeats…"
        />
      </div>
    </Card>
  );
}

function RiskHistory({ names }: { names: string[] }) {
  const [range, setRange] = useState<Range>('1h');
  const { hidden, toggle } = useHidden();
  const q = useQuery({ queryKey: ['node-risk', range], queryFn: () => http.get<RiskSeries>(`/api/nodes/risk?range=${range}`), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  const sorted = [...names].sort();
  const series = sorted.map((n) => ({ key: n, label: n, color: entityColor(n, sorted) }));
  const tick = timeTick(range);
  const rows = q.data?.series ?? [];
  return (
    <ChartCard
      title="Failure risk over time"
      description="0 to 100, sampled every 30 seconds. Dashed lines mark the warning (40) and high-risk (70) thresholds."
      fetching={q.isFetching && q.isPlaceholderData}
      legend={<Legend series={series} hidden={hidden} onToggle={toggle} />}
      action={<Segmented size="sm" label="Risk range" value={range} onChange={setRange} options={[{ value: '1h', label: '1h' }, { value: '6h', label: '6h' }, { value: '24h', label: '24h' }]} />}
      table={{ columns: ['Time', ...sorted], rows: rows.map((r) => [tick(r.t), ...sorted.map((n) => (typeof r[n] === 'number' ? Math.round((r[n] as number) * 100) : '—'))]) }}
    >
      {rows.length < 2 ? (
        <p className="px-5 py-16 text-center text-[13px] text-fg-3">History appears after a minute of samples.</p>
      ) : (
        <TimeSeries
          kind="line"
          data={rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 10 : v]))) as typeof rows}
          series={series}
          hidden={hidden}
          format={(v) => v.toFixed(0)}
          labelFormat={tick}
          yDomain={[0, 100]}
          references={[{ y: RISK_THRESHOLDS.warning * 100, label: 'warning' }, { y: RISK_THRESHOLDS.highRisk * 100, label: 'high risk' }]}
          height={220}
        />
      )}
    </ChartCard>
  );
}

function RingExplorer({ ring }: { ring: RingData }) {
  const [key, setKey] = useState('research-data/reports/q3.pdf');
  const [submitted, setSubmitted] = useState(key);
  const [down, setDown] = useState<Set<string>>(new Set());
  const loc = useQuery({ queryKey: ['locate', submitted], queryFn: () => http.get<{ pos: number }>(`/api/nodes/ring/locate?key=${encodeURIComponent(submitted)}`), enabled: !!submitted, placeholderData: keepPreviousData });
  const healthy = (id: string) => !down.has(id) && ring.nodes.find((n) => n.id === id)?.status !== 'OFFLINE';
  const walk = loc.data ? walkRing(ring.points, loc.data.pos, ring.replicationFactor, healthy) : null;
  return (
    <Card>
      <CardHeader title="Consistent hash ring" description={`${ring.nodes.length} nodes × ${ring.vnodesPerNode} virtual nodes. Type a key to see where it lands; switch a node off to watch placement fall through to the next node.`} />
      <div className="px-5 pb-5">
        <form
          className="mb-5 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(key.trim());
          }}
        >
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
            <Input aria-label="Key to place" value={key} onChange={(e) => setKey(e.target.value)} className="pl-8 font-mono text-[13px]" placeholder="bucket/key" />
          </div>
          <Button type="submit" variant="primary">Place key</Button>
        </form>
        <div className="mb-5 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-fg-2">Simulate:</span>
          {ring.nodes.map((n) => {
            const off = down.has(n.id) || n.status === 'OFFLINE';
            return (
              <button
                key={n.id}
                type="button"
                disabled={n.status === 'OFFLINE'}
                onClick={() => setDown((s) => { const x = new Set(s); if (x.has(n.id)) x.delete(n.id); else x.add(n.id); return x; })}
                aria-pressed={!off}
                className={cx('pressable inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 shadow-[0_0_0_1px_var(--border-2)]', off ? 'text-fg-3 line-through' : 'text-fg hover:bg-surface-2')}
              >
                <span className={cx('size-1.5 rounded-full', off ? 'bg-bad' : 'bg-good')} />
                {n.name}
              </button>
            );
          })}
          {down.size > 0 && <button className="text-fg-2 underline-offset-2 hover:underline" onClick={() => setDown(new Set())}>reset</button>}
        </div>
        <HashRingFigure ring={ring} walk={walk} markerLabel={loc.data ? `${(loc.data.pos * 100).toFixed(1)}%` : undefined} />
        {walk && walk.picks.length < ring.replicationFactor && (
          <p className="mt-4 text-[13px] text-bad-text">Only {plural(walk.picks.length, 'node is', 'nodes are')} available: a real upload would be rejected with 503 to protect durability.</p>
        )}
      </div>
    </Card>
  );
}

function NodeSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['node', id], queryFn: () => http.get<NodeDetail>(`/api/nodes/${id}`), enabled: !!id, refetchInterval: 15_000 });
  const n = q.data?.node;
  const isAdmin = useMe().data?.role === 'ADMIN';
  const qc = useQueryClient();
  const [confirmDrain, setConfirmDrain] = useState(false);
  const drain = useMutation({
    mutationFn: (on: boolean) => http.post<{ status: string }>(`/api/nodes/${id}/${on ? 'drain' : 'undrain'}`),
    onSuccess: (_r, on) => {
      setConfirmDrain(false);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      void qc.invalidateQueries({ queryKey: ['node', id] });
      toast.success(on ? `Draining ${n?.name}` : `${n?.name} accepts writes again`, { description: on ? 'No new writes. Self-healing is moving every replica to other nodes.' : undefined });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });
  const hist = (q.data?.history ?? []).map((h) => ({ t: h.ts, p50: h.latencyMsP50, p95: h.latencyMsP95, cpu: h.cpuPct, mem: h.memPct, disk: h.diskUsedPct, probe: h.probeMs }));
  const tick = timeTick('1h');
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()} title={n?.name ?? 'Node'} description={n?.baseUrl}>
      <div className="space-y-4 p-5">
        {q.isLoading ? (
          <Skeleton className="h-40" />
        ) : q.error ? (
          <ErrorNote error={q.error} />
        ) : n ? (
          <>
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              <NodeStatus status={n.status} />
              <span className="text-fg-2">Last heartbeat <RelativeTime iso={n.lastHeartbeatAt} /></span>
              {n.metrics && <span className="text-fg-2">· up {formatDuration(n.metrics.uptimeSec)}</span>}
            </div>
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-5">
                <RiskGauge score={n.riskScore} />
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="font-medium">Predicted failure risk</p>
                  <p className="mt-0.5 text-fg-2">
                    {n.riskScore >= RISK_THRESHOLDS.highRisk
                      ? 'High risk: no new writes go here and self-healing is copying its data to safer nodes.'
                      : n.riskScore >= RISK_THRESHOLDS.warning
                        ? 'Warning: still serving, watched closely. Writes continue.'
                        : 'Healthy: no signal points to an upcoming failure.'}
                  </p>
                  {n.risk?.updatedAt && <p className="mt-1 text-xs text-fg-3">Scored <RelativeTime iso={n.risk.updatedAt} /> from live metrics and recent history.</p>}
                </div>
              </div>
              {n.risk && (
                <div className="mt-4 border-t border-line pt-4">
                  <RiskBreakdown risk={n.risk} />
                </div>
              )}
            </Card>
            {isAdmin && (
              <div className="flex items-center justify-between gap-4 rounded-lg p-4 shadow-[inset_0_0_0_1px_var(--border)]">
                <div className="text-[13px]">
                  <p className="font-medium">{n.draining ? 'Node is draining' : 'Drain node'}</p>
                  <p className="text-fg-2">{n.draining ? 'Its replicas are being moved away. Stop to accept writes again.' : 'Stop new writes and move every replica to other nodes, e.g. before maintenance.'}</p>
                </div>
                {n.draining ? (
                  <Button loading={drain.isPending} onClick={() => drain.mutate(false)}>
                    <Undo2 /> Stop draining
                  </Button>
                ) : (
                  <Button onClick={() => setConfirmDrain(true)} disabled={n.status === 'OFFLINE'}>
                    <ArrowDownToLine /> Drain
                  </Button>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {[
                ['Replicas held', q.data!.replicaCount.toLocaleString()],
                ['Blobs on disk', n.blobCount.toLocaleString()],
                ['Disk used', `${formatBytes(n.usedBytes)} of ${formatBytes(n.capacityBytes)}`],
                ['Error rate', `${((n.metrics?.errorRate ?? 0) * 100).toFixed(2)}%`],
              ].map(([l, v]) => (
                <Card key={l} className="p-3.5">
                  <p className="text-xs text-fg-2">{l}</p>
                  <p className="mt-1 text-[15px] font-semibold tabular-nums">{v}</p>
                </Card>
              ))}
            </div>
            {hist.length < 2 ? (
              <p className="rounded-lg bg-surface-2 p-3 text-[13px] text-fg-2">History appears after a minute of samples (every 30 seconds).</p>
            ) : (
              <>
                <ChartCard title="Disk I/O probe" description="4 KB write + fsync + read, every heartbeat" table={{ columns: ['Time', 'Probe'], rows: hist.map((h) => [tick(h.t), `${h.probe} ms`]) }}>
                  <TimeSeries kind="area" data={hist} series={[{ key: 'probe', label: 'Probe', color: 'var(--series-1)' }]} format={(v) => `${v.toFixed(2)} ms`} labelFormat={tick} height={160} syncId="node" />
                </ChartCard>
                <ChartCard title="Request latency" description="Only measured while the node serves traffic" table={{ columns: ['Time', 'p50', 'p95'], rows: hist.map((h) => [tick(h.t), `${h.p50} ms`, `${h.p95} ms`]) }}>
                  <TimeSeries kind="line" data={hist} series={[{ key: 'p50', label: 'p50', color: 'var(--series-1)' }, { key: 'p95', label: 'p95', color: 'var(--series-2)' }]} format={(v) => `${v.toFixed(1)} ms`} labelFormat={tick} height={180} syncId="node" />
                </ChartCard>
                <ChartCard title="CPU and memory" table={{ columns: ['Time', 'CPU', 'Memory'], rows: hist.map((h) => [tick(h.t), `${h.cpu}%`, `${h.mem}%`]) }}>
                  <TimeSeries kind="line" data={hist} series={[{ key: 'cpu', label: 'CPU', color: 'var(--series-1)' }, { key: 'mem', label: 'Memory', color: 'var(--series-3)' }]} format={(v) => `${v.toFixed(0)}%`} labelFormat={tick} height={180} syncId="node" yDomain={[0, 100]} />
                </ChartCard>
              </>
            )}
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmDrain}
        onOpenChange={setConfirmDrain}
        tone="primary"
        title={`Drain ${n?.name ?? 'node'}?`}
        description="New writes will skip this node and self-healing will copy each of its replicas to another node before removing it here. Reads keep working throughout."
        confirmLabel="Start draining"
        onConfirm={() => drain.mutate(true)}
        busy={drain.isPending}
      />
    </Sheet>
  );
}

export function NodesPage() {
  const [params, setParams] = useSearchParams();
  const nodes = useNodes();
  const items = nodes.data?.items ?? [];
  const names = items.map((n) => n.name);
  const seeded = useSeededLive();
  const ring = useQuery({ queryKey: ['ring'], queryFn: () => http.get<RingData>('/api/nodes/ring') });
  const [uptimeRange, setUptimeRange] = useState<'1h' | '24h' | '7d'>('24h');
  const uptime = useQuery({ queryKey: ['uptime', uptimeRange], queryFn: () => http.get<UptimeData>(`/api/nodes/uptime?range=${uptimeRange}`), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  const healthy = items.filter((n) => n.status === 'HEALTHY').length;
  const atRisk = items.filter((n) => n.status === 'WARNING' || n.status === 'HIGH_RISK').length;
  const openId = params.get('node');

  useEffect(() => {
    if (openId && nodes.data && !items.some((n) => n.id === openId)) setParams({}, { replace: true });
  }, [openId, nodes.data, items, setParams]);

  return (
    <>
      <PageHeader
        title="Storage nodes"
        description={items.length ? `${healthy} of ${plural(items.length, 'node', 'nodes')} healthy${atRisk ? `, ${atRisk} at risk` : ''}. Every node is scored for failure risk every 10 seconds; data on risky or offline nodes is re-replicated automatically.` : 'Nodes register themselves with their first heartbeat.'}
      />
      {nodes.isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-80 rounded-xl" />)}</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((n) => (
            <NodeCard key={n.id} n={n} names={names} spark={(seeded[n.name] ?? []).map((p) => p.probe)} onOpen={() => setParams({ node: n.id })} />
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <LiveLatency names={names} seeded={seeded} />
        <RiskHistory names={names} />
      </div>

      <div className="mt-4">
        <HealingPanel />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {ring.data ? <RingExplorer ring={ring.data} /> : <Skeleton className="h-[520px] rounded-xl" />}
        <Card>
          <CardHeader title="Availability" description="Reconstructed from heartbeat transitions. Hover a bar for details." action={<Segmented size="sm" label="Uptime range" value={uptimeRange} onChange={setUptimeRange} options={[{ value: '1h', label: '1h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }]} />} />
          <div className={cx('px-5 pb-5 transition-opacity duration-200', uptime.isFetching && uptime.isPlaceholderData && 'opacity-60')}>{uptime.data ? <UptimeBars data={uptime.data} /> : <Skeleton className="h-48" />}</div>
        </Card>
      </div>

      <NodeSheet id={openId} onClose={() => setParams({})} />
    </>
  );
}
