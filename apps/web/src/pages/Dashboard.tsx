import { useQuery } from '@tanstack/react-query';
import { Box, Database, HardDrive, ServerCrash, Upload, Download, Trash2, ShieldAlert, Activity, UserRound, FolderPlus } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { http, type DashboardSummary } from '../api';
import { Badge, Card, CardHeader, EmptyState, ErrorNote, Loading, Meter, PageHeader, nodeTone } from '../components/ui';
import { formatBytes, humanizeAction, timeAgo } from '../lib/format';

const STATUS_COLOR: Record<string, string> = {
  HEALTHY: 'var(--ok)',
  WARNING: 'var(--warn)',
  HIGH_RISK: 'var(--bad)',
  OFFLINE: 'var(--bad)',
  DRAINING: 'var(--info)',
};

function Kpi({ icon, label, value, sub, children }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="grid size-8 place-items-center rounded-lg bg-brand-soft text-brand">{icon}</span>
        {label}
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
      {children && <div className="mt-3">{children}</div>}
    </Card>
  );
}

const activityIcon = (a: string) => {
  if (a.includes('upload')) return Upload;
  if (a.includes('download')) return Download;
  if (a.includes('delete')) return Trash2;
  if (a.startsWith('node')) return HardDrive;
  if (a.includes('integrity') || a.includes('mismatch')) return ShieldAlert;
  if (a.startsWith('auth')) return UserRound;
  if (a.startsWith('bucket')) return FolderPlus;
  return Activity;
};

function describe(a: DashboardSummary['recentActivity'][number]): string {
  const m = a.metadata as Record<string, string | number | undefined>;
  const target = m.key ?? m.bucket ?? m.name;
  return target ? `${target}` : (a.resourceType ?? '');
}

export function DashboardPage() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => http.get<DashboardSummary>('/api/dashboard/summary'),
    refetchInterval: 5000,
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorNote error={error ?? 'Could not load the dashboard'} />;

  const { storage, logical, nodes, perNode, recentActivity } = data;
  const donut = Object.entries(nodes.byStatus).filter(([, n]) => n > 0).map(([name, value]) => ({ name, value }));
  const bars = perNode.map((n) => ({ name: n.name.replace('storage-', ''), used: n.usedBytes, status: n.status }));

  return (
    <>
      <PageHeader title="Dashboard" description="Live view of your storage cluster. Refreshes every 5 seconds." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<HardDrive className="size-4" />} label="Storage used" value={formatBytes(storage.usedBytes)} sub={`of ${formatBytes(storage.capacityBytes)} raw capacity (${storage.usedPct}%)`}>
          <Meter pct={storage.usedPct} />
        </Kpi>
        <Kpi icon={<Box className="size-4" />} label="Objects" value={logical.objectCount.toLocaleString()} sub={`${formatBytes(logical.bytes)} logical size`} />
        <Kpi icon={<Database className="size-4" />} label="Buckets" value={logical.bucketCount.toLocaleString()} sub={<Link to="/buckets" className="text-brand hover:underline">Manage buckets →</Link>} />
        <Kpi
          icon={nodes.atRisk > 0 ? <ServerCrash className="size-4" /> : <HardDrive className="size-4" />}
          label="Healthy nodes"
          value={
            <span>
              {nodes.healthy}
              <span className="text-lg text-muted"> / {nodes.total}</span>
            </span>
          }
          sub={nodes.atRisk > 0 ? <span className="font-medium text-bad">{nodes.atRisk} at risk or offline</span> : 'All nodes operating normally'}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Storage usage per node" subtitle="Bytes stored on each storage node" />
          <div className="h-64 p-4">
            {bars.length === 0 ? (
              <EmptyState icon={<HardDrive className="size-5" />} title="No storage nodes yet" description="Nodes appear here after their first heartbeat." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bars} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="name" stroke="var(--muted)" tickLine={false} axisLine={false} fontSize={12} />
                  <YAxis stroke="var(--muted)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v: number) => formatBytes(v, 0)} width={60} />
                  <Tooltip
                    cursor={{ fill: 'var(--surface-2)' }}
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }}
                    formatter={(v) => [formatBytes(Number(v)), 'Used']}
                  />
                  <Bar isAnimationActive={false} dataKey="used" radius={[6, 6, 0, 0]} name="used" maxBarSize={72}>
                    {bars.map((b) => (
                      <Cell key={b.name} fill={b.status === 'HEALTHY' ? 'var(--brand)' : (STATUS_COLOR[b.status] ?? 'var(--brand)')} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Node health" />
          <div className="h-64 p-2">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie isAnimationActive={false} data={donut} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={donut.length > 1 ? 3 : 0} stroke="none">
                  {donut.map((d) => (
                    <Cell key={d.name} fill={STATUS_COLOR[d.name] ?? 'var(--muted)'} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }} />
                <Legend verticalAlign="bottom" iconType="circle" formatter={(v: string) => <span className="text-xs text-muted">{v.replace('_', ' ')}</span>} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Recent activity" action={<Link to="/audit" className="text-sm text-brand hover:underline">View audit log</Link>} />
          {recentActivity.length === 0 ? (
            <EmptyState icon={<Activity className="size-5" />} title="Nothing yet" description="Create a bucket and upload an object to see activity here." />
          ) : (
            <ul className="divide-y divide-border">
              {recentActivity.map((a) => {
                const Icon = activityIcon(a.action);
                return (
                  <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{humanizeAction(a.action)}</div>
                      <div className="truncate text-xs text-muted">
                        {describe(a)} · {a.actor ?? 'system'}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted">{timeAgo(a.createdAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Nodes" action={<Link to="/nodes" className="text-sm text-brand hover:underline">Details</Link>} />
          <ul className="divide-y divide-border">
            {perNode.map((n) => (
              <li key={n.id} className="space-y-2 px-5 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{n.name}</span>
                  <Badge tone={nodeTone(n.status)} dot>
                    {n.status.replace('_', ' ')}
                  </Badge>
                </div>
                <Meter pct={n.usedPct} />
                <div className="flex justify-between text-xs text-muted">
                  <span>{formatBytes(n.usedBytes)} used</span>
                  <span>{n.blobCount} blobs</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
