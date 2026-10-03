import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarList, ChartCard, entityColor, Legend, TimeSeries, timeTick, useHidden, type Series } from '../components/charts/chart-kit';
import { Segmented } from '../components/ui/overlays';
import { Card, CardHeader, Num, PageHeader, Skeleton } from '../components/ui/primitives';
import { http, type NodeMetricsSeries, type Range } from '../lib/api';
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
          {m ? <TimeSeries kind="line" data={m.probe} series={nodeSeries} hidden={probe.hidden} format={(v) => `${v.toFixed(2)} ms`} labelFormat={mTick} syncId="nodes" /> : <Skeleton className="m-3 h-52" />}
        </ChartCard>
        <ChartCard
          title="Request latency p95"
          description="Slowest 5% of blob requests per node (0 = idle)"
          fetching={metrics.isFetching && !!m}
          legend={<Legend series={nodeSeries} hidden={lat.hidden} onToggle={lat.toggle} />}
          table={m ? nodeTable(m.latencyP95, (v) => `${v} ms`) : undefined}
        >
          {m ? <TimeSeries kind="line" data={m.latencyP95} series={nodeSeries} hidden={lat.hidden} format={(v) => `${v.toFixed(1)} ms`} labelFormat={mTick} syncId="nodes" /> : <Skeleton className="m-3 h-52" />}
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
