import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCheck, FileWarning, Lock, LockOpen, RotateCcw, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ChartCard, Legend, TimeSeries } from '../components/charts/chart-kit';
import { Button } from '../components/ui/button';
import { ConfirmDialog, Modal, Segmented, Sheet, SwitchField } from '../components/ui/overlays';
import { Badge, Card, CardHeader, EmptyState, ErrorNote, Mono, PageHeader, RelativeTime, Skeleton, Th, Td, type Tone } from '../components/ui/primitives';
import { http, type RecoveryPlan, type SecurityEvent, type SecurityEventDetail, type SecuritySummary, type Severity } from '../lib/api';
import { cx, formatDateTime, formatNumber, formatTime, plural } from '../lib/format';

export const severityTone = (s: Severity): Tone => (s === 'CRITICAL' || s === 'HIGH' ? 'bad' : s === 'MEDIUM' ? 'warn' : 'neutral');
const KIND: Record<SecurityEvent['kind'], string> = { RANSOMWARE: 'Possible ransomware', MASS_DELETE: 'Mass deletion', ANOMALY: 'Unusual activity' };
const SIGNAL: Record<string, string> = {
  DELETE_BURST: 'Delete burst',
  OVERWRITE_BURST: 'Overwrite burst',
  ENTROPY_SHIFT: 'Encrypted overwrites',
  EXTENSION_CHURN: 'Ransomware file names',
  RATE_ANOMALY: 'Request-rate spike',
};
const STATUS: Record<SecurityEvent['status'], { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'bad' },
  ACKNOWLEDGED: { label: 'Acknowledged', tone: 'warn' },
  RESOLVED: { label: 'Resolved', tone: 'good' },
  FALSE_POSITIVE: { label: 'False positive', tone: 'neutral' },
};

const ACTIVITY_SERIES = [
  { key: 'uploads', label: 'Writes', color: 'var(--series-1)' },
  { key: 'suspicious', label: 'Encrypted overwrites', color: 'var(--series-2)' },
  { key: 'deletes', label: 'Deletes', color: 'var(--series-3)' },
];

export function SeverityBadge({ s }: { s: Severity }) {
  return (
    <Badge tone={severityTone(s)} icon>
      {s.charAt(0) + s.slice(1).toLowerCase()}
    </Badge>
  );
}

function SummaryTiles({ s }: { s: SecuritySummary }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<string | null>(null);
  const unlock = useMutation({
    mutationFn: (bucket: string) => http.patch(`/api/buckets/${encodeURIComponent(bucket)}`, { protectedMode: false }),
    onSuccess: (_r, bucket) => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['security'] });
      toast.success(`${bucket} unlocked`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Unlock failed'),
  });
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Card className="p-5">
        <p className="text-[13px] text-fg-2">Open alerts</p>
        <p className={cx('mt-1 text-2xl font-semibold tabular-nums', s.open > 0 && 'text-bad-text')}>{formatNumber(s.open)}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as Severity[]).map((k) => (
            <span key={k} className="inline-flex items-center gap-1 text-xs text-fg-2">
              <SeverityBadge s={k} />
              <span className="font-medium tabular-nums text-fg">{s.bySeverity[k] ?? 0}</span>
            </span>
          ))}
        </div>
      </Card>
      <Card className="p-5">
        <p className="text-[13px] text-fg-2">Protected versions</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(s.protectedVersions)}</p>
        <p className="mt-3 text-xs text-fg-3">Pre-attack copies made immutable for 30 days: they cannot be deleted and the retention purge skips them.</p>
      </Card>
      <Card className="p-5">
        <p className="text-[13px] text-fg-2">Locked buckets</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{s.lockedBuckets.length}</p>
        {s.lockedBuckets.length ? (
          <ul className="mt-2 space-y-1">
            {s.lockedBuckets.slice(0, 4).map((b) => (
              <li key={b} className="flex items-center gap-2 text-[13px]">
                <Lock className="size-3.5 text-fg-3" />
                <Link to={`/buckets/${encodeURIComponent(b)}`} className="min-w-0 flex-1 truncate font-mono text-xs hover:underline">{b}</Link>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(b)}>
                  <LockOpen /> Unlock
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-fg-3">Locked buckets refuse deletes and overwrites until an administrator unlocks them.</p>
        )}
      </Card>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="primary"
        title={`Unlock ${confirm}?`}
        description="Deletes and overwrites will be accepted again. Only unlock once the incident is resolved and the attacker's credentials are revoked."
        confirmLabel="Unlock bucket"
        onConfirm={() => confirm && unlock.mutate(confirm)}
        busy={unlock.isPending}
      />
    </div>
  );
}

function RecoveryModal({ event, open, onOpenChange }: { event: SecurityEvent; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ['security', 'plan', event.id], queryFn: () => http.get<RecoveryPlan>(`/api/security/events/${event.id}/recovery`), enabled: open });
  const apply = useMutation({
    mutationFn: () => http.post<{ restored: number; removed: number; failed: string[] }>(`/api/security/events/${event.id}/recover`),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['security'] });
      void qc.invalidateQueries({ queryKey: ['objects'] });
      onOpenChange(false);
      toast.success(`Recovered ${plural(r.restored, 'object', 'objects')}`, { description: `${r.removed} attacker-created ${r.removed === 1 ? 'object' : 'objects'} removed${r.failed.length ? `, ${r.failed.length} failed` : ''}.` });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Recovery failed'),
  });
  const p = plan.data;
  const actionLabel = { restore: 'Restore', remove: 'Remove', unchanged: 'Unchanged', unrecoverable: 'No clean copy' } as const;
  const actionTone = { restore: 'good', remove: 'warn', unchanged: 'neutral', unrecoverable: 'bad' } as const;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width="max-w-[680px]"
      title="Recover pre-attack data"
      description={
        <>
          Every key the actor touched since <span className="font-medium text-fg">{formatDateTime(event.attackStart)}</span> goes back to its last clean version. Nothing is copied: the new
          current version points at the protected bytes, and the attack's versions are kept until the retention purge.
        </>
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={apply.isPending} disabled={!p || p.summary.restore + p.summary.remove === 0} onClick={() => apply.mutate()}>
            <RotateCcw /> Recover {p ? p.summary.restore + p.summary.remove : ''} objects
          </Button>
        </>
      }
    >
      {plan.isLoading ? (
        <Skeleton className="h-48" />
      ) : plan.error ? (
        <ErrorNote error={plan.error} />
      ) : p ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(['restore', 'remove', 'unchanged', 'unrecoverable'] as const).map((k) => (
              <div key={k} className="rounded-lg p-3 shadow-[inset_0_0_0_1px_var(--border)]">
                <p className="text-xs text-fg-2">{actionLabel[k]}</p>
                <p className="text-lg font-semibold tabular-nums">{p.summary[k]}</p>
              </div>
            ))}
          </div>
          <div className="relative max-h-72 overflow-auto rounded-lg shadow-[inset_0_0_0_1px_var(--border)]">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <Th>Key</Th>
                  <Th>Action</Th>
                  <Th align="right">Version</Th>
                  <Th align="right">Entropy</Th>
                </tr>
              </thead>
              <tbody>
                {p.items.map((i) => (
                  <tr key={i.key} className="border-t border-line">
                    <Td className="max-w-[260px] truncate font-mono text-xs">{i.key}</Td>
                    <Td>
                      <Badge tone={actionTone[i.action]}>{actionLabel[i.action]}</Badge>
                    </Td>
                    <Td align="right" className="text-fg-2 tabular-nums">
                      {i.action === 'restore' ? `v${i.currentVersionNo ?? '–'} → v${i.cleanVersionNo}` : i.currentVersionNo ? `v${i.currentVersionNo}` : '—'}
                    </Td>
                    <Td align="right" className="text-fg-2 tabular-nums">
                      {i.currentEntropy !== null ? i.currentEntropy.toFixed(1) : '—'}
                      {i.action === 'restore' && i.cleanEntropy !== null && <span className="text-fg-3"> → {i.cleanEntropy.toFixed(1)}</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-fg-3">Entropy is in bits per byte: text and documents sit around 4–6, encrypted data near 8.</p>
        </>
      ) : null}
    </Modal>
  );
}

function EventSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['security', 'event', id], queryFn: () => http.get<SecurityEventDetail>(`/api/security/events/${id}`), enabled: !!id, refetchInterval: 10_000 });
  const [recover, setRecover] = useState(false);
  const [contain, setContain] = useState(false);
  const [revokeSessions, setRevokeSessions] = useState(false);
  const ev = q.data?.event;
  const update = useMutation({
    mutationFn: (status: SecurityEvent['status']) => http.patch(`/api/security/events/${id}`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['security'] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Update failed'),
  });
  const containM = useMutation({
    mutationFn: () => http.post<{ bucketLocked?: boolean; apiKeysRevoked?: number; sessionsRevoked?: number }>(`/api/security/events/${id}/contain`, { lockBucket: true, revokeApiKeys: true, revokeSessions }),
    onSuccess: (r) => {
      setContain(false);
      void qc.invalidateQueries({ queryKey: ['security'] });
      toast.success('Contained', { description: `Bucket locked · ${r.apiKeysRevoked ?? 0} API keys revoked${r.sessionsRevoked ? ` · ${r.sessionsRevoked} sessions ended` : ''}` });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Containment failed'),
  });
  const timeline = (q.data?.timeline ?? []).map((t) => ({ t: t.t, uploads: t.uploads - t.suspicious, suspicious: t.suspicious, deletes: t.deletes }));
  const active = ev && (ev.status === 'OPEN' || ev.status === 'ACKNOWLEDGED');

  return (
    <Sheet
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title={ev ? KIND[ev.kind] : 'Alert'}
      description={ev ? <span className="font-mono">{ev.bucket}</span> : undefined}
      actions={ev && <SeverityBadge s={ev.severity} />}
    >
      <div className="space-y-4 p-5">
        {q.isLoading ? (
          <Skeleton className="h-60" />
        ) : q.error ? (
          <ErrorNote error={q.error} />
        ) : ev ? (
          <>
            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              {[
                ['Status', <Badge key="s" tone={STATUS[ev.status].tone}>{STATUS[ev.status].label}</Badge>],
                ['Actor', <span key="a" className="truncate">{ev.actor ?? 'anonymous'}{ev.actorType === 'API_KEY' && <span className="text-fg-3"> · API key</span>}</span>],
                ['Attack started', formatDateTime(ev.attackStart)],
                ['Last activity', <RelativeTime key="l" iso={ev.lastSeenAt} />],
                ['Versions protected', formatNumber(ev.protectedVersions)],
                ['Containment', ev.contained ? <span key="b" className="inline-flex items-center gap-1 text-warn-text"><Lock className="size-3.5" /> Bucket locked</span> : 'None yet'],
              ].map(([l, v]) => (
                <div key={l as string} className="rounded-lg p-3 shadow-[inset_0_0_0_1px_var(--border)]">
                  <dt className="text-xs text-fg-2">{l}</dt>
                  <dd className="mt-1 min-w-0 font-medium">{v}</dd>
                </div>
              ))}
            </dl>

            <Card>
              <CardHeader title="Why this was flagged" />
              <ul className="divide-y divide-line px-5 pb-2">
                {ev.signals.map((s) => (
                  <li key={s.signal} className="flex items-start gap-3 py-2.5 text-[13px]">
                    <FileWarning className="mt-0.5 size-4 shrink-0 text-fg-3" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{SIGNAL[s.signal] ?? s.signal}</p>
                      <p className="text-fg-2">{s.detail}</p>
                    </div>
                    <SeverityBadge s={s.severity} />
                  </li>
                ))}
              </ul>
            </Card>

            {timeline.length > 0 && (
              <ChartCard title="Actor activity" description="Writes per minute in this bucket around the attack" legend={<Legend series={ACTIVITY_SERIES} mark="rect" />} table={{ columns: ['Minute', 'Writes', 'Encrypted', 'Deletes'], rows: timeline.map((t) => [formatTime(t.t), t.uploads, t.suspicious, t.deletes]) }}>
                <TimeSeries
                  kind="bar"
                  stacked
                  data={timeline}
                  series={ACTIVITY_SERIES}
                  format={(v) => formatNumber(v)}
                  labelFormat={(t) => formatTime(t)}
                  height={180}
                />
              </ChartCard>
            )}

            {(q.data?.actions.length ?? 0) > 0 && (
              <Card>
                <CardHeader title="Recent actions" description="Newest first. Entropy jumping to ~8 bits per byte means the content was encrypted." />
                <ul className="max-h-64 divide-y divide-line overflow-y-auto">
                  {q.data!.actions.map((a, i) => (
                    <li key={i} className="flex items-center gap-3 px-5 py-2 text-[13px]">
                      <Badge tone={a.action === 'object.delete' ? 'warn' : a.entropy !== null && a.entropy >= 7.5 && (a.prev ?? 8) < 6 ? 'bad' : 'neutral'}>{a.action === 'object.delete' ? 'Delete' : 'Write'}</Badge>
                      <Mono className="min-w-0 flex-1 truncate text-fg-2">{a.key}</Mono>
                      {a.entropy !== null && (
                        <span className="shrink-0 text-xs text-fg-3 tabular-nums">
                          {a.prev !== null && `${a.prev.toFixed(1)} → `}
                          {a.entropy.toFixed(1)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {ev.recovery && (
              <div className="rounded-lg bg-good-soft p-3.5 text-[13px] text-good-text">
                <p className="font-medium">Recovered {formatDateTime(ev.recovery.at)} by {ev.recovery.by}</p>
                <p className="mt-0.5 opacity-90">
                  {ev.recovery.restored} restored · {ev.recovery.removed} removed · {ev.recovery.unchanged} unchanged{ev.recovery.failed.length ? ` · ${ev.recovery.failed.length} failed` : ''}
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {ev.bucket && active && (
                <Button variant="primary" onClick={() => setRecover(true)}>
                  <RotateCcw /> Recover data
                </Button>
              )}
              {active && !ev.contained && (
                <Button onClick={() => setContain(true)}>
                  <Ban /> Contain
                </Button>
              )}
              {ev.status === 'OPEN' && (
                <Button loading={update.isPending && update.variables === 'ACKNOWLEDGED'} onClick={() => update.mutate('ACKNOWLEDGED')}>
                  <CheckCheck /> Acknowledge
                </Button>
              )}
              {active && (
                <Button variant="ghost" loading={update.isPending && update.variables === 'FALSE_POSITIVE'} onClick={() => update.mutate('FALSE_POSITIVE')}>
                  <ShieldX /> False positive
                </Button>
              )}
              {active && (
                <Button variant="ghost" loading={update.isPending && update.variables === 'RESOLVED'} onClick={() => update.mutate('RESOLVED')}>
                  <ShieldCheck /> Resolve
                </Button>
              )}
            </div>

            <RecoveryModal event={ev} open={recover} onOpenChange={setRecover} />
            <ConfirmDialog
              open={contain}
              onOpenChange={setContain}
              title="Contain this actor?"
              description={
                <>
                  Locks <span className="font-mono text-fg">{ev.bucket}</span> (deletes and overwrites are refused) and revokes every API key of <span className="font-medium text-fg">{ev.actor}</span>.
                </>
              }
              confirmLabel="Contain"
              onConfirm={() => containM.mutate()}
              busy={containM.isPending}
            >
              <SwitchField checked={revokeSessions} onChange={setRevokeSessions} label="Also sign the actor out everywhere" description="Ends their browser sessions too." />
            </ConfirmDialog>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

export function SecurityPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'ACTIVE' | 'ALL' | 'RESOLVED'>('ACTIVE');
  const summary = useQuery({ queryKey: ['security', 'summary'], queryFn: () => http.get<SecuritySummary>('/api/security/summary'), refetchInterval: 15_000 });
  const events = useQuery({
    queryKey: ['security', 'events', filter],
    queryFn: () => http.get<{ items: SecurityEvent[] }>(`/api/security/events${filter === 'ACTIVE' ? '?status=ACTIVE' : filter === 'RESOLVED' ? '?status=RESOLVED' : ''}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const items = events.data?.items ?? [];
  const openId = params.get('event');

  return (
    <>
      <PageHeader
        title="Security"
        description="Ransomware and anomaly detection over every write and delete. On a high-severity alert the pre-attack versions are protected automatically; buckets that opted in are locked."
      />
      {summary.data ? <SummaryTiles s={summary.data} /> : <Skeleton className="h-36 rounded-xl" />}

      <Card className="mt-4">
        <CardHeader
          title="Alerts"
          action={<Segmented size="sm" label="Show" value={filter} onChange={setFilter} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'RESOLVED', label: 'Resolved' }, { value: 'ALL', label: 'All' }]} />}
        />
        {events.isLoading ? (
          <Skeleton className="mx-5 mb-5 h-32" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={filter === 'ACTIVE' ? 'No active alerts' : 'Nothing here yet'}
            description="Run the ransomware drill in the Simulation Lab to see detection, protection and recovery end to end."
            action={<Link to="/lab" className="text-[13px] font-medium underline-offset-2 hover:underline">Open the Simulation Lab</Link>}
          />
        ) : (
          <ul className={cx('divide-y divide-line border-t border-line transition-opacity duration-200', events.isPlaceholderData && 'opacity-60')}>
            {items.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => setParams({ event: e.id })} className="flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors duration-150 hover:bg-surface-2/60">
                  <span className={cx('mt-0.5 grid size-8 shrink-0 place-items-center rounded-full', severityTone(e.severity) === 'bad' ? 'bg-bad-soft text-bad-text' : 'bg-warn-soft text-warn-text')}>
                    <ShieldAlert className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="font-medium">{KIND[e.kind]}</span>
                      <span className="font-mono text-xs text-fg-2">{e.bucket}</span>
                      <SeverityBadge s={e.severity} />
                      <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
                      {e.contained && (
                        <Badge tone="info">
                          <Lock className="size-3" /> Contained
                        </Badge>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-fg-2">
                      {e.actor ?? 'anonymous'} · {e.signals.map((s) => SIGNAL[s.signal] ?? s.signal).join(', ')} · {formatNumber(e.protectedVersions)} versions protected
                    </p>
                  </div>
                  <RelativeTime iso={e.createdAt} className="shrink-0 text-xs text-fg-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <EventSheet id={openId} onClose={() => setParams({})} />
    </>
  );
}
