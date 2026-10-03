import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ScrollText, Search, ShieldCheck } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { http, type AuditItem } from '../api';
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Loading, Mono, PageHeader, Pagination, Select, Td, Th, useToast } from '../components/ui';
import { useMe } from '../hooks';
import { formatDate, humanizeAction } from '../lib/format';

const GROUPS = [
  { value: '', label: 'All actions' },
  { value: 'auth.', label: 'Authentication' },
  { value: 'bucket.', label: 'Buckets' },
  { value: 'object.', label: 'Objects' },
  { value: 'grant.', label: 'Permissions' },
  { value: 'apikey.', label: 'API keys' },
  { value: 'node.', label: 'Storage nodes' },
];

const tone = (a: string) => (a.includes('fail') || a.includes('mismatch') || a.includes('offline') || a.includes('delete') ? 'bad' : a.includes('upload') || a.includes('create') || a.includes('online') || a.includes('register') ? 'ok' : 'neutral');

export function AuditPage() {
  const me = useMe().data;
  const toast = useToast();
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDq(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', action, dq, page],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (action) p.set('action', action);
      if (dq) p.set('q', dq);
      return http.get<{ items: AuditItem[]; total: number; page: number; pageSize: number }>(`/api/audit?${p}`);
    },
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });

  const verify = async () => {
    setVerifying(true);
    try {
      const r = await http.get<{ ok: boolean; checked: number; brokenAtSeq?: number }>('/api/audit/verify');
      toast(r.ok ? 'ok' : 'bad', r.ok ? `Audit chain intact (${r.checked} entries verified)` : `Chain broken at entry #${r.brokenAtSeq}`);
    } catch (e) {
      toast('bad', e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Audit logs"
        description={me?.role === 'ADMIN' ? 'Every security-relevant action across the system.' : 'A record of your own actions.'}
        actions={
          me?.role === 'ADMIN' && (
            <Button onClick={verify} loading={verifying}>
              <ShieldCheck className="size-4" /> Verify integrity
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-56 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <Input aria-label="Search audit log" placeholder="Search actor, action or details…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <Select aria-label="Filter by category" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} className="w-48">
            {GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </Select>
        </div>

        {isLoading ? (
          <Loading />
        ) : error ? (
          <div className="p-5"><ErrorNote error={error} /></div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState icon={<ScrollText className="size-5" />} title="No matching entries" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-border bg-surface-2/50">
                  <tr><Th className="w-8" /><Th>When</Th><Th>Action</Th><Th>Actor</Th><Th>Target</Th></tr>
                </thead>
                <tbody>
                  {data.items.map((a) => {
                    const open = expanded === a.id;
                    const m = a.metadata as Record<string, unknown>;
                    return (
                      <Fragment key={a.id}>
                        <tr className="cursor-pointer border-b border-border hover:bg-surface-2/40" onClick={() => setExpanded(open ? null : a.id)}>
                          <Td>{open ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}</Td>
                          <Td className="whitespace-nowrap text-muted">{formatDate(a.createdAt)}</Td>
                          <Td><Badge tone={tone(a.action)}>{humanizeAction(a.action)}</Badge></Td>
                          <Td>{a.actor ?? <span className="text-muted">anonymous</span>}{a.actorType === 'SYSTEM' && <span className="ml-1 text-xs text-muted">(system)</span>}</Td>
                          <Td className="max-w-xs truncate text-muted">{String(m.key ?? m.bucket ?? m.name ?? a.resourceType ?? '')}</Td>
                        </tr>
                        {open && (
                          <tr className="border-b border-border bg-surface-2/40">
                            <td />
                            <td colSpan={4} className="space-y-2 px-4 py-3">
                              <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                                <div><span className="text-muted">Entry </span>#{a.seq}</div>
                                <div><span className="text-muted">IP </span>{a.ip ?? '—'}</div>
                                <div className="sm:col-span-2"><span className="text-muted">Request </span><Mono>{a.requestId ?? '—'}</Mono></div>
                              </div>
                              <pre className="max-h-48 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs">{JSON.stringify(a.metadata, null, 2)}</pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
