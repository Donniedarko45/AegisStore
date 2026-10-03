import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Activity, ChevronRight, Download, FolderPlus, HardDrive, KeyRound, Search, ShieldAlert, ShieldCheck, Trash2, Upload, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { SelectBox } from '../components/ui/overlays';
import { Badge, Card, EmptyState, ErrorNote, Input, Mono, PageHeader, RelativeTime, Skeleton, type Tone } from '../components/ui/primitives';
import { Spinner } from '../components/ui/spinner';
import { http, type AuditItem } from '../lib/api';
import { cx, formatDateTime, humanizeAction } from '../lib/format';
import { useMe } from '../lib/queries';

const GROUPS = [
  { value: 'all', label: 'All events' },
  { value: 'object.', label: 'Objects' },
  { value: 'bucket.', label: 'Buckets' },
  { value: 'auth.', label: 'Sign-ins' },
  { value: 'grant.', label: 'Permissions' },
  { value: 'apikey.', label: 'API keys' },
  { value: 'node.', label: 'Storage nodes' },
  { value: 'user.', label: 'Users' },
  { value: 'retention.', label: 'Retention' },
];

const iconFor = (a: string) =>
  a.includes('upload') ? Upload : a.includes('download') ? Download : a.includes('delete') || a.includes('purge') ? Trash2 : a.startsWith('node') ? HardDrive : a.includes('integrity') || a.includes('mismatch') || a.includes('failed') ? ShieldAlert : a.startsWith('auth') || a.startsWith('user') ? UserRound : a.startsWith('bucket') ? FolderPlus : a.startsWith('apikey') ? KeyRound : Activity;
const toneFor = (a: string): Tone => (a.includes('fail') || a.includes('mismatch') || a.includes('offline') || a.includes('corrupt') ? 'bad' : a.includes('delete') || a.includes('purge') || a.includes('revoke') ? 'warn' : a.includes('online') || a.includes('register') || a.includes('restore') ? 'good' : 'neutral');

/** JSON with keys de-emphasised so values read first. Rendered as text nodes (never innerHTML). */
function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="relative overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px] leading-relaxed">
      {JSON.stringify(value, null, 2)
        .split('\n')
        .map((line, i) => {
          const m = /^(\s*)"([^"]+)":(.*)$/.exec(line);
          return (
            <div key={i}>
              {m ? (
                <>
                  {m[1]}
                  <span className="text-fg-3">"{m[2]}":</span>
                  <span className="text-fg">{m[3]}</span>
                </>
              ) : (
                <span className="text-fg-2">{line}</span>
              )}
            </div>
          );
        })}
    </pre>
  );
}

function Row({ ev, open, onToggle }: { ev: AuditItem; open: boolean; onToggle: () => void }) {
  const Icon = iconFor(ev.action);
  const m = ev.metadata as Record<string, unknown>;
  const target = (m.key ?? m.bucket ?? m.name ?? m.email ?? ev.resourceType ?? '') as string;
  return (
    <div className="border-b border-line last:border-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-150 hover:bg-surface-2/60">
        <ChevronRight className={cx('size-4 shrink-0 text-fg-3 transition-transform duration-200 ease-out', open && 'rotate-90')} />
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-2">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={toneFor(ev.action)}>{humanizeAction(ev.action)}</Badge>
            <span className="truncate text-fg-2">{String(target)}</span>
          </p>
          <p className="mt-0.5 truncate text-xs text-fg-3">
            {ev.actor ?? 'anonymous'}
            {ev.actorType === 'SYSTEM' && ' (system)'}
            {ev.actorType === 'API_KEY' && ' via API key'}
            {ev.ip && ` · ${ev.ip}`}
          </p>
        </div>
        <RelativeTime iso={ev.createdAt} className="shrink-0 text-xs text-fg-3" />
      </button>
      {open && (
        <div className="space-y-2 px-5 pb-4 pl-[60px] text-xs">
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-fg-2 sm:grid-cols-2">
            <span>Entry <Mono className="text-fg">#{ev.seq}</Mono></span>
            <span>{formatDateTime(ev.createdAt)}</span>
            {ev.requestId && <span className="sm:col-span-2">Request <Mono className="text-fg">{ev.requestId}</Mono></span>}
          </div>
          <JsonView value={ev.metadata} />
        </div>
      )}
    </div>
  );
}

export function ActivityPage() {
  const me = useMe().data;
  const [group, setGroup] = useState('all');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const feed = useInfiniteQuery({
    queryKey: ['audit', group, dq],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ page: String(pageParam), pageSize: '50' });
      if (group !== 'all') p.set('action', group);
      if (dq) p.set('q', dq);
      return http.get<{ items: AuditItem[]; total: number; page: number; pageSize: number }>(`/api/audit?${p}`);
    },
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    refetchInterval: 20_000,
  });
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const total = feed.data?.pages[0]?.total ?? 0;

  const verify = useMutation({
    mutationFn: () => http.get<{ ok: boolean; checked: number; brokenAtSeq?: number }>('/api/audit/verify'),
    onSuccess: (r) => (r.ok ? toast.success('Audit chain intact', { description: `${r.checked.toLocaleString()} entries verified: no edits or deletions.` }) : toast.error('Audit chain broken', { description: `Tampering detected at entry #${r.brokenAtSeq}.` })),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Verification failed'),
  });

  return (
    <>
      <PageHeader
        title="Activity"
        description={me?.role === 'ADMIN' ? 'Every security-relevant event in the cluster. Entries are hash-chained: any edit or deletion is detectable.' : 'A tamper-evident record of your own actions.'}
        actions={me?.role === 'ADMIN' && <Button onClick={() => verify.mutate()} loading={verify.isPending}><ShieldCheck /> Verify integrity</Button>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
          <Input aria-label="Search activity" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by actor, action or detail…" className="pl-8" />
        </div>
        <SelectBox label="Event type" value={group} onChange={setGroup} options={GROUPS} className="w-44" />
        <span className="text-[13px] text-fg-2 tabular-nums">{total.toLocaleString()} events</span>
      </div>
      <Card className="overflow-hidden">
        {feed.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : feed.error ? (
          <div className="p-4"><ErrorNote error={feed.error} /></div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Activity />} title="No matching events" description="Try a different filter." />
        ) : (
          // virtualised: the log can hold hundreds of thousands of rows
          <Virtuoso
            useWindowScroll
            data={items}
            computeItemKey={(_, ev) => ev.id}
            endReached={() => feed.hasNextPage && !feed.isFetchingNextPage && void feed.fetchNextPage()}
            itemContent={(_, ev) => (
              <Row
                ev={ev}
                open={open.has(ev.id)}
                onToggle={() => setOpen((s) => { const n = new Set(s); if (n.has(ev.id)) n.delete(ev.id); else n.add(ev.id); return n; })}
              />
            )}
            components={{
              Footer: () => (feed.isFetchingNextPage ? <div className="flex justify-center py-4 text-fg-2"><Spinner /></div> : !feed.hasNextPage && items.length > 20 ? <p className="py-4 text-center text-xs text-fg-3">Beginning of the log</p> : null),
            }}
          />
        )}
      </Card>
    </>
  );
}
