import { useQuery } from '@tanstack/react-query';
import { Clock, Cpu, Gauge, HardDrive, MemoryStick, Network } from 'lucide-react';
import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { http, type NodeDetail, type NodeDto } from '../api';
import { Badge, Card, CardHeader, Drawer, EmptyState, ErrorNote, Loading, Meter, PageHeader, nodeTone } from '../components/ui';
import { formatBytes, formatDate, timeAgo } from '../lib/format';

const Stat = ({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) => (
  <div className="flex items-center gap-2 text-sm">
    <span className="text-muted">{icon}</span>
    <span className="text-muted">{label}</span>
    <span className="ml-auto font-medium tabular-nums">{value}</span>
  </div>
);

function NodeCard({ n, onOpen }: { n: NodeDto; onOpen: () => void }) {
  const usedPct = n.capacityBytes ? (n.usedBytes / n.capacityBytes) * 100 : 0;
  const offline = n.status === 'OFFLINE';
  return (
    <button onClick={onOpen} className="block w-full text-left" aria-label={`Open details for ${n.name}`}>
      <Card className={`space-y-4 p-5 transition-shadow hover:shadow-md ${offline ? 'border-bad/40' : ''}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={`grid size-10 place-items-center rounded-lg ${offline ? 'bg-bad-soft text-bad' : 'bg-brand-soft text-brand'}`}>
              <HardDrive className="size-5" />
            </span>
            <div>
              <div className="font-semibold">{n.name}</div>
              <div className="text-xs text-muted">{n.baseUrl}</div>
            </div>
          </div>
          <Badge tone={nodeTone(n.status)} dot>
            {n.status.replace('_', ' ')}
          </Badge>
        </div>

        <div>
          <div className="mb-1.5 flex justify-between text-xs text-muted">
            <span>{formatBytes(n.usedBytes)} used</span>
            <span>{formatBytes(n.capacityBytes)}</span>
          </div>
          <Meter pct={usedPct} />
        </div>

        <div className="space-y-2 border-t border-border pt-3">
          <Stat icon={<Cpu className="size-4" />} label="CPU" value={n.metrics ? `${n.metrics.cpuPct.toFixed(0)}%` : '—'} />
          <Stat icon={<MemoryStick className="size-4" />} label="Memory" value={n.metrics ? `${n.metrics.memPct.toFixed(0)}%` : '—'} />
          <Stat icon={<Gauge className="size-4" />} label="Latency p95" value={n.metrics ? `${n.metrics.latencyMsP95.toFixed(1)} ms` : '—'} />
          <Stat icon={<Network className="size-4" />} label="Hash ring share" value={`${n.ringSharePct}%`} />
          <Stat icon={<Clock className="size-4" />} label="Last heartbeat" value={<span className={offline ? 'text-bad' : ''}>{timeAgo(n.lastHeartbeatAt)}</span>} />
        </div>
      </Card>
    </button>
  );
}

function HistoryChart({ title, data, unit, series }: { title: string; data: Record<string, number | string>[]; unit: string; series: { key: string; name: string; color: string }[] }) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="h-44 p-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="t" stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
            <YAxis stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} unit={unit} />
            <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }} />
            {series.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function NodeDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['node', id], queryFn: () => http.get<NodeDetail>(`/api/nodes/${id}`), refetchInterval: 5000 });
  const n = data?.node;
  const points = (data?.history ?? []).map((h) => ({
    t: new Date(h.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    cpu: h.cpuPct,
    mem: h.memPct,
    disk: h.diskUsedPct,
    p50: h.latencyMsP50,
    p95: h.latencyMsP95,
  }));
  return (
    <Drawer title={n?.name ?? 'Node'} subtitle={n?.baseUrl} onClose={onClose}>
      {isLoading ? (
        <Loading />
      ) : error || !n ? (
        <div className="p-5"><ErrorNote error={error ?? 'Not found'} /></div>
      ) : (
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone={nodeTone(n.status)} dot>{n.status.replace('_', ' ')}</Badge>
            <span className="text-muted">Last heartbeat {timeAgo(n.lastHeartbeatAt)} ({formatDate(n.lastHeartbeatAt)})</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Card className="p-3"><div className="text-xs text-muted">Replicas stored</div><div className="text-xl font-semibold tabular-nums">{data?.replicaCount}</div></Card>
            <Card className="p-3"><div className="text-xs text-muted">Blobs on disk</div><div className="text-xl font-semibold tabular-nums">{n.blobCount}</div></Card>
            <Card className="p-3"><div className="text-xs text-muted">Error rate</div><div className="text-xl font-semibold tabular-nums">{((n.metrics?.errorRate ?? 0) * 100).toFixed(1)}%</div></Card>
            <Card className="p-3"><div className="text-xs text-muted">Uptime</div><div className="text-xl font-semibold tabular-nums">{n.metrics ? `${Math.floor(n.metrics.uptimeSec / 60)}m` : '—'}</div></Card>
          </div>
          {points.length < 2 ? (
            <p className="rounded-lg bg-surface-2 px-4 py-3 text-sm text-muted">Health history appears after a couple of minutes of metrics (sampled every 30 seconds).</p>
          ) : (
            <>
              <HistoryChart title="CPU & memory" unit="%" data={points} series={[{ key: 'cpu', name: 'CPU %', color: 'var(--brand)' }, { key: 'mem', name: 'Memory %', color: 'var(--info)' }]} />
              <HistoryChart title="Request latency" unit=" ms" data={points} series={[{ key: 'p50', name: 'p50', color: 'var(--ok)' }, { key: 'p95', name: 'p95', color: 'var(--warn)' }]} />
              <HistoryChart title="Disk usage" unit="%" data={points} series={[{ key: 'disk', name: 'Disk %', color: 'var(--bad)' }]} />
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

export function NodesPage() {
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['nodes'], queryFn: () => http.get<{ items: NodeDto[] }>('/api/nodes'), refetchInterval: 5000 });
  const items = data?.items ?? [];
  const healthy = items.filter((n) => n.status === 'HEALTHY').length;

  return (
    <>
      <PageHeader title="Storage nodes" description={items.length ? `${healthy} of ${items.length} nodes healthy. A node is marked offline after 15 seconds without a heartbeat.` : 'Nodes register themselves with a heartbeat every 5 seconds.'} />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorNote error={error} />
      ) : items.length === 0 ? (
        <Card><EmptyState icon={<HardDrive className="size-5" />} title="No storage nodes registered" description="Start the storage-node containers; they appear here after their first heartbeat." /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((n) => (
            <NodeCard key={n.id} n={n} onOpen={() => setOpen(n.id)} />
          ))}
        </div>
      )}
      {open && <NodeDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
