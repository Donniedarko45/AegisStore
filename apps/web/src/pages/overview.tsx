import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Database, Download, FolderPlus, HardDrive, ShieldAlert, Trash2, Upload, UserRound, Wrench, XCircle } from 'lucide-react';
import { useHealing } from '../components/app/healing';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BarList, ChartCard, Legend, SegmentBar, Sparkline, TimeSeries, timeTick, useHidden } from '../components/charts/chart-kit';
import { Topology } from '../components/figures/topology';
import { Segmented } from '../components/ui/overlays';
import { Bytes, Card, CardHeader, EmptyState, Meter, NodeStatus, Num, PageHeader, RelativeTime, Skeleton } from '../components/ui/primitives';
import { http, type AnalyticsOverview, type Range, type SecuritySummary } from '../lib/api';
import { formatBytes, formatCompact, formatNumber, humanizeAction, plural } from '../lib/format';
import { useDashboard, useMe, useNodes, usePollInterval } from '../lib/queries';

export const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

export function useAnalytics(range: Range) {
  const refetchInterval = usePollInterval(15_000, 60_000);
  return useQuery({
    queryKey: ['analytics', range],
    queryFn: () => http.get<AnalyticsOverview>(`/api/analytics/overview?range=${range}`),
    placeholderData: keepPreviousData,
    refetchInterval,
  });
}

const activityIcon = (a: string) =>
  a.includes('upload') ? Upload : a.includes('download') ? Download : a.includes('delete') ? Trash2 : a.startsWith('node') ? HardDrive : a.includes('integrity') || a.includes('mismatch') ? ShieldAlert : a.startsWith('auth') ? UserRound : a.startsWith('bucket') ? FolderPlus : Activity;

function StatTile({ label, children, sub, trend }: { label: string; children: React.ReactNode; sub?: React.ReactNode; trend?: number[] }) {
  return (
    <Card className="flex flex-col p-5">
      <p className="text-[13px] text-fg-2">{label}</p>
      <div className="mt-3 text-[28px] leading-none font-semibold tracking-[-0.02em]">{children}</div>
      {trend ? <Sparkline values={trend} className="mt-4" height={30} /> : null}
      {sub && <p className="mt-auto pt-3 text-xs text-fg-2">{sub}</p>}
    </Card>
  );
}

export function OverviewPage() {
  const [range, setRange] = useState<Range>('24h');
  const dash = useDashboard();
  const nodes = useNodes();
  const an = useAnalytics(range);
  const { hidden, toggle } = useHidden();
  const d = dash.data;
  const a = an.data;
  const isAdmin = useMe().data?.role === 'ADMIN';
  const security = useQuery({ queryKey: ['security', 'summary'], queryFn: () => http.get<SecuritySummary>('/api/security/summary'), enabled: isAdmin, refetchInterval: 30_000 });
  const healing = useHealing();
  const hq = healing.data?.queue;
  const tick = timeTick(range);

  const requests = (a?.totals.uploads ?? 0) + (a?.totals.downloads ?? 0);
  const integrityTotal = a ? a.integrity.healthy + a.integrity.degraded + a.integrity.unavailable : 0;
  const healthyPct = integrityTotal ? (a!.integrity.healthy / integrityTotal) * 100 : 100;
  const series = [
    { key: 'uploads', label: 'Uploads', color: 'var(--series-1)' },
    { key: 'downloads', label: 'Downloads', color: 'var(--series-2)' },
  ];

  return (
    <>
      <PageHeader
        title="Overview"
        description="Your storage cluster at a glance. Updates live."
        actions={<Segmented label="Time range" value={range} onChange={setRange} options={RANGE_OPTIONS} />}
      />
      {isAdmin && (security.data?.open ?? 0) > 0 && (
        <Link
          to="/security"
          className="mb-4 flex items-center gap-3 rounded-lg bg-bad-soft px-4 py-3 text-[13px] text-bad-text transition-opacity duration-150 hover:opacity-90"
        >
          <ShieldAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{plural(security.data!.open, 'open security alert', 'open security alerts')}</span>
            <span className="opacity-90"> · {formatNumber(security.data!.protectedVersions)} versions protected{security.data!.lockedBuckets.length ? ` · ${plural(security.data!.lockedBuckets.length, 'bucket', 'buckets')} locked` : ''}</span>
          </span>
          <span className="shrink-0 font-medium">Review →</span>
        </Link>
      )}

      {/* KPI row; one hero figure (stored data) leads */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="flex flex-col p-5 sm:col-span-2 xl:col-span-1">
          <p className="text-[13px] text-fg-2">Stored data</p>
          <div className="mt-3 text-5xl leading-none font-semibold tracking-[-0.035em]">{d ? <Bytes value={d.logical.bytes} /> : <Skeleton className="h-12 w-36" />}</div>
          {a && <Sparkline values={a.storage.map((s) => s.bytes)} className="mt-4" height={30} />}
          <p className="mt-auto pt-3 text-xs text-fg-2">{d ? `${formatBytes(d.storage.usedBytes)} raw across replicas · ${d.storage.usedPct}% of capacity` : ' '}</p>
        </Card>
        <StatTile label="Objects" sub={d ? `in ${plural(d.logical.bucketCount, 'bucket', 'buckets')}` : undefined} trend={a?.storage.map((s) => s.objects)}>
          {d ? <Num value={d.logical.objectCount} /> : <Skeleton className="h-8 w-20" />}
        </StatTile>
        <StatTile label={`Requests · ${range}`} sub={a ? `${formatCompact(a.totals.uploads)} uploads · ${formatCompact(a.totals.downloads)} downloads` : undefined} trend={a?.activity.map((p) => p.uploads + p.downloads)}>
          {a ? <Num value={requests} /> : <Skeleton className="h-8 w-20" />}
        </StatTile>
        <StatTile
          label="Healthy nodes"
          sub={
            d ? (
              d.nodes.atRisk ? (
                <span className="inline-flex items-center gap-1 font-medium text-bad-text">
                  <AlertTriangle className="size-3.5" /> {plural(d.nodes.atRisk, 'node needs', 'nodes need')} attention
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-good-text">
                  <CheckCircle2 className="size-3.5" /> All nodes operational
                </span>
              )
            ) : undefined
          }
        >
          {d ? (
            <span>
              <Num value={d.nodes.healthy} />
              <span className="text-lg font-medium text-fg-3"> / {d.nodes.total}</span>
            </span>
          ) : (
            <Skeleton className="h-8 w-16" />
          )}
        </StatTile>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Requests"
          description="Uploads and downloads per interval"
          fetching={an.isFetching && !!a}
          legend={<Legend series={series} hidden={hidden} onToggle={toggle} mark="rect" />}
          table={a ? { columns: ['Time', 'Uploads', 'Downloads'], rows: a.activity.filter((p) => p.uploads || p.downloads).map((p) => [tick(p.t), p.uploads, p.downloads]) } : undefined}
        >
          {a ? (
            <TimeSeries kind="bar" stacked data={a.activity} series={series} hidden={hidden} format={formatNumber} labelFormat={tick} height={240} />
          ) : (
            <Skeleton className="m-3 h-[228px]" />
          )}
        </ChartCard>

        <Card className="flex flex-col">
          <CardHeader title="Cluster" description="Live heartbeats from every storage node" action={<Link to="/nodes" className="text-[13px] text-fg-2 hover:text-fg">View nodes</Link>} />
          <div className="flex flex-1 items-center px-3 pb-3">{nodes.data ? <Topology nodes={nodes.data.items} /> : <Skeleton className="h-48 w-full" />}</div>
        </Card>

        <ChartCard
          className="lg:col-span-2"
          title="Storage growth"
          description="Bytes stored across all versions you can access"
          fetching={an.isFetching && !!a}
          table={a ? { columns: ['Time', 'Stored', 'Objects'], rows: a.storage.map((s) => [tick(s.t), formatBytes(s.bytes), s.objects]) } : undefined}
        >
          {a ? (
            <TimeSeries kind="area" data={a.storage} series={[{ key: 'bytes', label: 'Stored', color: 'var(--series-1)' }]} format={(v) => formatBytes(v)} axisFormat={(v) => formatBytes(v, 0)} labelFormat={tick} height={220} />
          ) : (
            <Skeleton className="m-3 h-[208px]" />
          )}
        </ChartCard>

        <Card className="flex flex-col">
          <CardHeader title="Data integrity" description="Current objects by available replicas" />
          <div className="px-5 pb-5">
            {a ? (
              <>
                <p className="mb-3 text-[28px] leading-none font-semibold tracking-tight">
                  <Num value={Math.round(healthyPct * 10) / 10} suffix="%" />
                  <span className="ml-2 text-[13px] font-normal text-fg-2">fully replicated</span>
                </p>
                <SegmentBar
                  parts={[
                    { key: 'h', label: 'Healthy', value: a.integrity.healthy, color: 'var(--good)', icon: <CheckCircle2 className="size-3.5 text-good" /> },
                    { key: 'd', label: 'Degraded', value: a.integrity.degraded, color: 'var(--warn)', icon: <AlertTriangle className="size-3.5 text-warn" /> },
                    { key: 'u', label: 'Unavailable', value: a.integrity.unavailable, color: 'var(--bad)', icon: <XCircle className="size-3.5 text-bad" /> },
                  ]}
                />
                {hq && (
                  <Link to="/nodes" className="mt-4 flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[13px] text-fg-2 transition-colors duration-150 hover:text-fg">
                    <Wrench className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      Self-healing: {hq.running + hq.queued > 0 ? `${hq.running + hq.queued} jobs in progress` : 'idle'} · {formatNumber(hq.repaired24h)} copies repaired in 24 h
                    </span>
                  </Link>
                )}
              </>
            ) : (
              <Skeleton className="h-16" />
            )}
          </div>
          <div className="mt-auto border-t border-line px-5 py-4">
            <p className="mb-3 text-[13px] font-medium">Node usage</p>
            <ul className="space-y-3">
              {(d?.perNode ?? []).map((n) => (
                <li key={n.id}>
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-[13px]">
                    <span className="truncate">{n.name}</span>
                    <span className="text-fg-2 tabular-nums">{formatBytes(n.usedBytes)}</span>
                  </div>
                  <Meter value={n.usedPct} label={`${n.name} disk usage`} tone={n.status === 'WARNING' ? 'warn' : n.status === 'HIGH_RISK' || n.status === 'OFFLINE' ? 'bad' : undefined} />
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Recent activity" action={<Link to="/audit" className="text-[13px] text-fg-2 hover:text-fg">View all</Link>} />
          {d && d.recentActivity.length === 0 ? (
            <EmptyState icon={<Activity />} title="No activity yet" description="Create a bucket and upload a file to see it here." />
          ) : (
            <ul className="divide-y divide-line">
              {(d?.recentActivity ?? []).slice(0, 8).map((ev) => {
                const Icon = activityIcon(ev.action);
                const m = ev.metadata as Record<string, string | number | undefined>;
                return (
                  <li key={ev.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-2">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]">
                        <span className="font-medium">{humanizeAction(ev.action)}</span>
                        {(m.key ?? m.bucket ?? m.name) && <span className="text-fg-2"> · {String(m.key ?? m.bucket ?? m.name)}</span>}
                      </p>
                      <p className="truncate text-xs text-fg-3">{ev.actor ?? 'system'}</p>
                    </div>
                    <RelativeTime iso={ev.createdAt} className="shrink-0 text-xs text-fg-3" />
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Largest buckets" action={<Link to="/buckets" className="text-[13px] text-fg-2 hover:text-fg">All buckets</Link>} />
          <BarList
            empty="No buckets yet"
            format={(v) => formatBytes(v)}
            items={(a?.byBucket ?? []).map((b) => ({ key: b.bucket, label: <span className="flex items-center gap-2"><Database className="size-3.5 text-fg-3" />{b.bucket}</span>, value: b.bytes, sub: `${formatCompact(b.objects)} obj` }))}
          />
          <div className="border-t border-line px-5 py-3">
            <p className="text-[13px] font-medium">Nodes</p>
            <ul className="mt-2 space-y-2">
              {(nodes.data?.items ?? []).map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="truncate">{n.name}</span>
                  <NodeStatus status={n.status} />
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
    </>
  );
}
