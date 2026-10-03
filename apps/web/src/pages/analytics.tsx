import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarList, ChartCard, entityColor, Legend, SegmentBar, TimeSeries, timeTick, useHidden, type Series } from '../components/charts/chart-kit';
import { Flame, Snowflake, ThermometerSun } from 'lucide-react';
import { Segmented } from '../components/ui/overlays';
import { Card, CardHeader, Num, PageHeader, Skeleton } from '../components/ui/primitives';
import { http, type HealingActivity, type NodeMetricsSeries, type Range } from '../lib/api';
import { formatBytes, formatCompact, formatNumber } from '../lib/format';
import { RANGE_OPTIONS, useAnalytics } from './overview';

const METRIC_RANGE: Record<Range, Range> = { '1h': '1h', '6h': '6h', '24h': '24h', '7d': '24h', '30d': '24h' };

function Totals({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <Card className="grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
      {items.map((i) => (
        <div key={i.label} className="px-5 py-4">
          <p className="text-[13px] text-fg-2">{i.label}</p>
          <p className="mt-1.5 text-xl font-semibold tracking-tight">{i.value}</p>
        </div>
      ))}
    </Card>
  );
}

const CLASS_LABEL = { HOT: 'Hot', WARM: 'Warm', COLD: 'Cold' } as const;
// class is an identity (not a status): categorical slots, plus an icon and a label on every use
const CLASS_COLOR = { COLD: 'var(--series-1)', HOT: 'var(--series-2)', WARM: 'var(--series-3)' } as const;
function ClassIcon({ c }: { c: 'HOT' | 'WARM' | 'COLD' }) {
  const Icon = c === 'HOT' ? Flame : c === 'COLD' ? Snowflake : ThermometerSun;
  return <Icon className="size-3.5" style={{ color: CLASS_COLOR[c] }} />;
}
const HEAL_SERIES: Series[] = [
  { key: 'repaired', label: 'Repaired', color: 'var(--series-1)' },
  { key: 'trimmed', label: 'Trimmed', color: 'var(--series-2)' },
  { key: 'verified', label: 'Verified', color: 'var(--series-3)' },
];
const CHANGE_SERIES: Series[] = [
  { key: 'promoted', label: 'Promoted to HOT', color: 'var(--series-2)' },
  { key: 'demoted', label: 'Demoted', color: 'var(--series-1)' },
];

export function AnalyticsPage() {
  const [range, setRange] = useState<Range>('24h');
  const navigate = useNavigate();
  const an = useAnalytics(range);
  const a = an.data;
  const tick = timeTick(range);
  const metrics = useQuery({
    queryKey: ['node-metrics', METRIC_RANGE[range]],
    queryFn: () => http.get<NodeMetricsSeries>(`/api/nodes/metrics?range=${METRIC_RANGE[range]}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const m = metrics.data;
  const heal = useQuery({ queryKey: ['healing', 'activity', range], queryFn: () => http.get<HealingActivity>(`/api/healing/activity?range=${range}`), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  const mTick = timeTick(METRIC_RANGE[range]);
  const nodeSeries: Series[] = (m?.nodes ?? []).map((n) => ({ key: n, label: n, color: entityColor(n, m?.nodes ?? []) }));

  const req = useHidden();
  const bw = useHidden();
  const lat = useHidden();
  const probe = useHidden();
  const cpu = useHidden();
  const reqSeries = [
    { key: 'uploads', label: 'Uploads', color: 'var(--series-1)' },
    { key: 'downloads', label: 'Downloads', color: 'var(--series-2)' },
  ];
  const bwSeries = [
    { key: 'uploadBytes', label: 'Ingress', color: 'var(--series-1)' },
    { key: 'downloadBytes', label: 'Egress', color: 'var(--series-2)' },
  ];
  const nodeTable = (rows: NodeMetricsSeries['cpu'], fmt: (v: number) => string) => ({
    columns: ['Time', ...(m?.nodes ?? [])],
    rows: rows.map((r) => [mTick(r.t), ...(m?.nodes ?? []).map((n) => (typeof r[n] === 'number' ? fmt(r[n] as number) : '—'))]),
  });

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Traffic, storage and node performance. The range applies to every chart on this page."
        actions={<Segmented label="Time range" value={range} onChange={setRange} options={RANGE_OPTIONS} />}
      />

      {a ? (
        <Totals
          items={[
            { label: 'Uploads', value: <Num value={a.totals.uploads} /> },
            { label: 'Downloads', value: <Num value={a.totals.downloads} /> },
            { label: 'Ingress', value: formatBytes(a.totals.uploadBytes) },
            { label: 'Egress', value: formatBytes(a.totals.downloadBytes) },
            { label: 'Deletes', value: <Num value={a.totals.deletes} /> },
            { label: 'Integrity failures', value: <Num value={a.totals.integrityFailures} /> },
          ]}
        />
      ) : (
        <Skeleton className="h-[86px] rounded-xl" />
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Requests"
          description="Count per interval"
          fetching={an.isFetching && !!a}
          legend={<Legend series={reqSeries} hidden={req.hidden} onToggle={req.toggle} mark="rect" />}
          table={a ? { columns: ['Time', 'Uploads', 'Downloads'], rows: a.activity.map((p) => [tick(p.t), p.uploads, p.downloads]) } : undefined}
        >
          {a ? <TimeSeries kind="bar" stacked data={a.activity} series={reqSeries} hidden={req.hidden} format={formatNumber} labelFormat={tick} syncId="traffic" /> : <Skeleton className="m-3 h-52" />}
        </ChartCard>
        <ChartCard
          title="Bandwidth"
          description="Bytes in and out of the cluster (one axis: both are bytes)"
          fetching={an.isFetching && !!a}
          legend={<Legend series={bwSeries} hidden={bw.hidden} onToggle={bw.toggle} />}
          table={a ? { columns: ['Time', 'Ingress', 'Egress'], rows: a.activity.map((p) => [tick(p.t), formatBytes(p.uploadBytes), formatBytes(p.downloadBytes)]) } : undefined}
        >
          {a ? <TimeSeries kind="area" data={a.activity} series={bwSeries} hidden={bw.hidden} format={(v) => formatBytes(v)} axisFormat={(v) => formatBytes(v, 0)} labelFormat={tick} syncId="traffic" /> : <Skeleton className="m-3 h-52" />}
        </ChartCard>

        <ChartCard
          title="Stored bytes"
          description="All live and recoverable versions"
          fetching={an.isFetching && !!a}
          table={a ? { columns: ['Time', 'Stored', 'Objects'], rows: a.storage.map((s) => [tick(s.t), formatBytes(s.bytes), s.objects]) } : undefined}
        >
          {a ? <TimeSeries kind="area" data={a.storage} series={[{ key: 'bytes', label: 'Stored', color: 'var(--series-1)' }]} format={(v) => formatBytes(v)} axisFormat={(v) => formatBytes(v, 0)} labelFormat={tick} syncId="traffic" /> : <Skeleton className="m-3 h-52" />}
        </ChartCard>
        <ChartCard
          title="Object sizes"
          description="Current objects by size band"
          table={a ? { columns: ['Size', 'Objects'], rows: a.sizeHistogram.map((s) => [s.bucket, s.objects]) } : undefined}
        >
          {a ? (
            <BarList format={formatNumber} items={a.sizeHistogram.map((s) => ({ key: s.bucket, label: s.bucket, value: s.objects }))} />
          ) : (
            <Skeleton className="m-3 h-52" />
          )}
        </ChartCard>

        <Card>
          <CardHeader title="Content types" description="Share of stored bytes" />
          <BarList format={(v) => formatBytes(v)} items={(a?.byType ?? []).map((t) => ({ key: t.type, label: <span className="font-mono text-[12.5px]">{t.type}</span>, value: t.bytes, sub: `${formatCompact(t.objects)} obj` }))} />
        </Card>
        <Card>
          <CardHeader title="Most downloaded" description={`Objects with the most downloads in the last ${range}`} />
          <BarList
            empty="No downloads in this range"
            format={(v) => `${formatCompact(v)}×`}
            onSelect={(k) => {
              const [bucket, ...key] = k.split('\u0000');
              navigate(`/buckets/${encodeURIComponent(bucket!)}?object=${encodeURIComponent(key.join('\u0000'))}`);
            }}
            items={(a?.topDownloads ?? []).map((t) => ({ key: `${t.bucket}\u0000${t.key}`, label: <span className="truncate"><span className="text-fg-3">{t.bucket}/</span>{t.key}</span>, value: t.downloads, sub: formatBytes(t.bytes) }))}
          />
        </Card>
      </div>

      <h2 className="mt-10 mb-1 text-base font-semibold tracking-tight">Access classes and replication</h2>
      <p className="mb-4 text-[13px] text-fg-2">Objects read often become HOT and get an extra replica; self-healing repairs, trims and re-verifies copies continuously.</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Access classes" description="Current versions by how often they are read" />
          <div className="px-5 pb-5">
            {a ? (
              <>
                <SegmentBar
                  parts={a.byClass.map((c) => ({ key: c.class, label: CLASS_LABEL[c.class], value: c.objects, color: CLASS_COLOR[c.class], icon: <ClassIcon c={c.class} /> }))}
                />
                <table className="mt-4 w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-xs text-fg-2">
                      <th className="pb-1.5 font-normal">Class</th>
                      <th className="pb-1.5 text-right font-normal">Stored</th>
                      <th className="pb-1.5 text-right font-normal">Reads 24 h</th>
                      <th className="pb-1.5 text-right font-normal">Copies</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {a.byClass.map((c) => (
                      <tr key={c.class}>
                        <td className="py-1.5">{CLASS_LABEL[c.class]}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatBytes(c.bytes)}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatCompact(c.reads24h)}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatNumber(c.replicas)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <Skeleton className="h-32" />
            )}
          </div>
        </Card>
        <ChartCard
          title="Replication activity"
          description="Self-healing jobs finished per interval"
          value={heal.data ? <span>{formatBytes(heal.data.series.reduce((x, r) => x + r.bytes, 0))} copied</span> : undefined}
          fetching={heal.isFetching && heal.isPlaceholderData}
          legend={<Legend series={HEAL_SERIES} mark="rect" />}
          table={heal.data ? { columns: ['Time', 'Repaired', 'Trimmed', 'Verified', 'Failed'], rows: heal.data.series.map((r) => [tick(r.t), r.repaired, r.trimmed, r.verified, r.failed]) } : undefined}
        >
          {heal.data ? <TimeSeries kind="bar" stacked data={heal.data.series} series={HEAL_SERIES} format={(v) => formatNumber(v)} labelFormat={tick} height={200} /> : <Skeleton className="m-3 h-48" />}
        </ChartCard>
        <ChartCard
          title="Class changes"
          description="Promotions to HOT and demotions"
          legend={<Legend series={CHANGE_SERIES} mark="rect" />}
          table={a ? { columns: ['Time', 'Promoted', 'Demoted'], rows: a.classChanges.map((r) => [tick(r.t), r.promoted, r.demoted]) } : undefined}
        >
          {a ? <TimeSeries kind="bar" data={a.classChanges} series={CHANGE_SERIES} format={(v) => formatNumber(v)} labelFormat={tick} height={200} /> : <Skeleton className="m-3 h-48" />}
        </ChartCard>
      </div>

      <h2 className="mt-10 mb-1 text-base font-semibold tracking-tight">Node performance</h2>
      <p className="mb-4 text-[13px] text-fg-2">Sampled every 30 seconds{range === '7d' || range === '30d' ? ' · showing the last 24h (metric retention is shorter)' : ''}. Hover any chart to compare all nodes at that moment.</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard
          title="Disk I/O latency"
          description="Probe on every heartbeat: 4 KB write, fsync, read"
          fetching={metrics.isFetching && !!m}
          legend={<Legend series={nodeSeries} hidden={probe.hidden} onToggle={probe.toggle} />}
          table={m ? nodeTable(m.probe, (v) => `${v} ms`) : undefined}
        >
          {m ? <TimeSeries kind="line" data={m.probe} series={nodeSeries} hidden={probe.hidden} format={(v) => `${v.toFixed(2)} ms`} axisFormat={(v) => `${Math.round(v)} ms`} labelFormat={mTick} syncId="nodes" /> : <Skeleton className="m-3 h-52" />}
        </ChartCard>
        <ChartCard
          title="Request latency p95"
          description="Slowest 5% of blob requests per node (0 = idle)"
          fetching={metrics.isFetching && !!m}
          legend={<Legend series={nodeSeries} hidden={lat.hidden} onToggle={lat.toggle} />}
          table={m ? nodeTable(m.latencyP95, (v) => `${v} ms`) : undefined}
        >
          {m ? <TimeSeries kind="line" data={m.latencyP95} series={nodeSeries} hidden={lat.hidden} format={(v) => `${v.toFixed(1)} ms`} axisFormat={(v) => `${Math.round(v)} ms`} labelFormat={mTick} syncId="nodes" /> : <Skeleton className="m-3 h-52" />}
        </ChartCard>
        <ChartCard
          title="CPU"
          description="Host CPU utilisation per node"
          fetching={metrics.isFetching && !!m}
          legend={<Legend series={nodeSeries} hidden={cpu.hidden} onToggle={cpu.toggle} />}
          table={m ? nodeTable(m.cpu, (v) => `${v}%`) : undefined}
        >
          {m ? <TimeSeries kind="line" data={m.cpu} series={nodeSeries} hidden={cpu.hidden} format={(v) => `${v.toFixed(0)}%`} labelFormat={mTick} syncId="nodes" yDomain={[0, 100]} /> : <Skeleton className="m-3 h-52" />}
        </ChartCard>
      </div>
    </>
  );
}
