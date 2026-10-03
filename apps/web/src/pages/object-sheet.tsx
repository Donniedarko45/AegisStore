import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, Flame, History, Link2, Lock, RotateCcw, ScanSearch, Snowflake, ThermometerSun, Trash2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { HashRingFigure, walkRing } from '../components/figures/hash-ring';
import { Button, buttonStyles } from '../components/ui/button';
import { ConfirmDialog, Segmented, Sheet, TabsBar, Tip } from '../components/ui/overlays';
import { Sparkline } from '../components/charts/chart-kit';
import { Badge, CopyButton, ErrorNote, integrityLabel, integrityTone, Mono, NodeStatus, RelativeTime, Skeleton } from '../components/ui/primitives';
import { http, objectUrl, type ObjectDetails, type RingData, type ShareLink } from '../lib/api';
import { useMe } from '../lib/queries';
import { cx, formatBytes, formatDateTime, relativeTime } from '../lib/format';

type Tab = 'overview' | 'replicas' | 'placement' | 'versions' | 'share';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4 py-3 text-[13px]">
      <dt className="text-fg-2">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

const CLASS_INFO = {
  HOT: { icon: Flame, text: 'Read often: kept on an extra replica so reads spread across more nodes.' },
  WARM: { icon: ThermometerSun, text: 'Normal access: stored on the bucket\'s baseline number of replicas.' },
  COLD: { icon: Snowflake, text: 'Not read for 14 days: baseline replicas, first candidate for cheaper storage later.' },
} as const;

function AccessCard({ d }: { d: ObjectDetails }) {
  const cur = d.current!;
  const info = CLASS_INFO[cur.storageClass];
  const Icon = info.icon;
  return (
    <div className="mt-4 rounded-lg p-4 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-fg-2">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 text-[13px]">
          <p className="font-medium">
            {cur.storageClass} <span className="font-normal text-fg-2">· target {cur.targetReplicas} replicas</span>
          </p>
          <p className="text-fg-2">{info.text}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <p className="text-xs text-fg-2">Reads, 24 h</p>
          <p className="font-semibold tabular-nums">{d.access.reads24h.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-fg-2">Reads, 7 days</p>
          <p className="font-semibold tabular-nums">{d.access.reads7d.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-fg-2">Last read</p>
          <p className="font-semibold">{d.access.lastAccessedAt ? relativeTime(d.access.lastAccessedAt) : 'never'}</p>
        </div>
      </div>
      <div className="mt-3">
        <p className="mb-1 text-xs text-fg-3">Reads per hour, last 48 h</p>
        <Sparkline values={d.access.hourly.map((h) => h.reads)} height={36} />
      </div>
    </div>
  );
}

const SHARE_STATUS: Record<ShareLink['status'], { label: string; tone: 'good' | 'neutral' | 'warn' | 'bad' }> = {
  ACTIVE: { label: 'Active', tone: 'good' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  USED_UP: { label: 'Limit reached', tone: 'warn' },
  REVOKED: { label: 'Revoked', tone: 'neutral' },
};

function SharePanel({ bucket, objectKey, versionNo }: { bucket: string; objectKey: string; versionNo: number }) {
  const qc = useQueryClient();
  const [ttl, setTtl] = useState<'3600' | '86400' | '604800'>('86400');
  const [cap, setCap] = useState<'0' | '1' | '5' | '25'>('0');
  const [created, setCreated] = useState<string | null>(null);
  const base = `/api/buckets/${encodeURIComponent(bucket)}/object`;
  const links = useQuery({ queryKey: ['shares', bucket, objectKey], queryFn: () => http.get<{ items: ShareLink[] }>(`${base}/shares?key=${encodeURIComponent(objectKey)}`) });
  const create = useMutation({
    mutationFn: () => http.post<{ url: string }>(`${base}/share?key=${encodeURIComponent(objectKey)}`, { expiresInSec: Number(ttl), ...(cap !== '0' && { maxDownloads: Number(cap) }) }),
    onSuccess: (r) => {
      setCreated(`${location.origin}${r.url}`);
      void qc.invalidateQueries({ queryKey: ['shares', bucket, objectKey] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not create the link'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => http.del(`/api/shares/${id}`),
    onSuccess: () => {
      setCreated(null);
      void qc.invalidateQueries({ queryKey: ['shares', bucket, objectKey] });
      toast.success('Link revoked', { description: 'It stops working immediately.' });
    },
  });
  return (
    <div className="space-y-5">
      <div className="rounded-lg p-4 shadow-[inset_0_0_0_1px_var(--border)]">
        <p className="text-[13px] font-medium">Create a share link</p>
        <p className="mt-0.5 text-[13px] text-fg-2">Anyone with the link can download version {versionNo} without signing in, until it expires or is revoked.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Segmented size="sm" label="Expires after" value={ttl} onChange={setTtl} options={[{ value: '3600', label: '1 hour' }, { value: '86400', label: '1 day' }, { value: '604800', label: '7 days' }]} />
          <Segmented size="sm" label="Download limit" value={cap} onChange={setCap} options={[{ value: '0', label: 'No limit' }, { value: '1', label: '1×' }, { value: '5', label: '5×' }, { value: '25', label: '25×' }]} />
        </div>
        <Button variant="primary" className="mt-4" loading={create.isPending} onClick={() => create.mutate()}>
          <Link2 /> Create link
        </Button>
        {created && (
          <div className="enter mt-4 flex items-center gap-1 rounded-md bg-surface-2 py-1 pr-1 pl-2.5">
            <Mono className="min-w-0 flex-1 truncate text-fg">{created}</Mono>
            <CopyButton text={created} label="Copy link" />
          </div>
        )}
      </div>
      <div>
        <p className="mb-2 text-[13px] font-medium">Links</p>
        {links.data?.items.length ? (
          <ul className="divide-y divide-line rounded-lg shadow-[inset_0_0_0_1px_var(--border)]">
            {links.data.items.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={SHARE_STATUS[l.status].tone}>{SHARE_STATUS[l.status].label}</Badge>
                    <span className="text-fg-2">
                      v{l.versionNo} · {l.downloads}
                      {l.maxDownloads ? ` / ${l.maxDownloads}` : ''} downloads
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-fg-3">
                    {l.status === 'ACTIVE' ? `expires ${relativeTime(l.expiresAt)}` : `created ${relativeTime(l.createdAt)}`} · by {l.createdBy ?? 'unknown'}
                  </p>
                </div>
                {l.status === 'ACTIVE' && (
                  <Button size="sm" variant="danger-ghost" loading={revoke.isPending && revoke.variables === l.id} onClick={() => revoke.mutate(l.id)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-fg-3">No links yet.</p>
        )}
      </div>
    </div>
  );
}

export function ObjectSheet({ bucket, objectKey, canWrite, onClose }: { bucket: string; objectKey: string | null; canWrite: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const isAdmin = useMe().data?.role === 'ADMIN';
  const [confirmDelete, setConfirmDelete] = useState(false);
  const qc = useQueryClient();
  const open = !!objectKey;
  const key = objectKey ?? '';

  const details = useQuery({
    queryKey: ['object', bucket, key],
    queryFn: () => http.get<ObjectDetails>(`/api/buckets/${encodeURIComponent(bucket)}/object/details?key=${encodeURIComponent(key)}`),
    enabled: open,
    refetchInterval: open ? 10_000 : false,
  });
  const ring = useQuery({ queryKey: ['ring'], queryFn: () => http.get<RingData>('/api/nodes/ring'), enabled: open && tab === 'placement' });
  const d = details.data;
  const cur = d?.current;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['object', bucket, key] });
    void qc.invalidateQueries({ queryKey: ['objects', bucket] });
    void qc.invalidateQueries({ queryKey: ['bucket', bucket] });
    void qc.invalidateQueries({ queryKey: ['deleted', bucket] });
  };
  const del = useMutation({
    mutationFn: () => http.del(objectUrl(bucket, key)),
    onSuccess: () => {
      invalidate();
      setConfirmDelete(false);
      onClose();
      toast.success(`Deleted ${key}`, { description: 'Restorable from “Recently deleted” until the retention purge.' });
    },
  });
  const verifyNow = useMutation({
    mutationFn: () => http.post<{ queued: number }>(`/api/buckets/${encodeURIComponent(bucket)}/object/verify?key=${encodeURIComponent(key)}`),
    onSuccess: (r) => toast.success(`Re-hashing ${r.queued} replicas`, { description: 'Results appear here within seconds.' }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });
  const restore = useMutation({
    mutationFn: (versionId: string) => http.post<{ versionNo: number }>(`/api/buckets/${encodeURIComponent(bucket)}/object/restore?key=${encodeURIComponent(key)}&versionId=${versionId}`),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Restored as version ${r.versionNo}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Restore failed'),
  });

  const walk = useMemo(() => {
    if (!ring.data || !d?.placement) return null;
    const holders = new Set(d.replicas.map((r) => r.nodeId));
    // replay the ring walk against the nodes that actually hold replicas
    return walkRing(ring.data.points, d.placement.ringPos, holders.size || ring.data.replicationFactor, (id) => holders.size === 0 || holders.has(id));
  }, [ring.data, d]);

  const healthyReplicas = d?.replicas.filter((r) => r.state === 'HEALTHY' && r.nodeStatus !== 'OFFLINE').length ?? 0;
  const fileName = key.split('/').pop() || key;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={fileName}
      description={<span className="font-mono">{bucket}/{key}</span>}
      actions={
        cur && (
          <>
            <Tip content="Copy API path">
              <span>
                <CopyButton text={`${location.origin}${objectUrl(bucket, key)}`} label="Copy API path" className="size-8" />
              </span>
            </Tip>
            <a href={objectUrl(bucket, key)} download className={buttonStyles({ variant: 'primary', size: 'sm' })}>
              <Download /> Download
            </a>
          </>
        )
      }
    >
      <div className="px-5 pt-2">
        <TabsBar
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'replicas', label: 'Replicas', count: d?.replicas.length },
            { value: 'placement', label: 'Placement' },
            { value: 'versions', label: 'Versions', count: d?.versions.length },
            ...(cur ? [{ value: 'share' as const, label: 'Share' }] : []),
          ]}
        />
      </div>

      <div className="px-5 py-5">
        {details.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24" />
          </div>
        ) : details.error ? (
          <ErrorNote error={details.error} />
        ) : !d ? null : tab === 'overview' ? (
          <>
            {cur ? (
              <>
                <div className={cx('mb-4 flex items-start gap-3 rounded-lg p-3.5 text-[13px]', cur.integrity === 'HEALTHY' ? 'bg-good-soft text-good-text' : cur.integrity === 'DEGRADED' ? 'bg-warn-soft text-warn-text' : 'bg-bad-soft text-bad-text')}>
                  {cur.integrity === 'HEALTHY' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : cur.integrity === 'DEGRADED' ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
                  <div>
                    <p className="font-medium">{integrityLabel(cur.integrity)}: {healthyReplicas} of {cur.targetReplicas} replicas available</p>
                    <p className="mt-0.5 opacity-90">
                      {cur.integrity === 'HEALTHY'
                        ? healthyReplicas < cur.targetReplicas
                          ? 'Every replica matches the SHA-256 recorded at upload. The extra copy for this HOT object is added as soon as an eligible node is free.'
                          : 'Every replica matches the SHA-256 recorded at upload.'
                        : cur.integrity === 'DEGRADED'
                          ? 'Downloads still work from a healthy replica. Self-healing will restore the missing copy.'
                          : 'No healthy replica is reachable right now.'}
                    </p>
                  </div>
                </div>
                <dl className="divide-y divide-line">
                  <Row label="Size">
                    {formatBytes(cur.size)} <span className="text-fg-3">({cur.size.toLocaleString()} bytes)</span>
                  </Row>
                  <Row label="Content type"><Mono>{cur.contentType}</Mono></Row>
                  <Row label="SHA-256">
                    <span className="flex items-start gap-1">
                      <Mono className="flex-1 leading-relaxed">{cur.sha256}</Mono>
                      <CopyButton text={cur.sha256} label="Copy checksum" />
                    </span>
                  </Row>
                  <Row label="Version">v{cur.versionNo}</Row>
                  <Row label="Storage class"><Badge>{cur.storageClass}</Badge></Row>
                  <Row label="Uploaded">{formatDateTime(cur.createdAt)} <span className="text-fg-3">({relativeTime(cur.createdAt)})</span></Row>
                  <Row label="Version ID"><Mono className="text-fg-2">{cur.versionId}</Mono></Row>
                </dl>
                <p className="mt-4 rounded-lg bg-surface-2 p-3 text-xs text-fg-2">
                  Verify locally: <Mono>sha256sum {fileName}</Mono> should print the checksum above.
                </p>
                <AccessCard d={d} />
              </>
            ) : (
              <p className="text-sm text-fg-2">This object has no current version: it was deleted. Restore an older version from the Versions tab.</p>
            )}
            {canWrite && cur && (
              <div className="mt-6 flex items-center justify-between gap-4 rounded-lg p-4 shadow-[inset_0_0_0_1px_var(--border)]">
                <div className="text-[13px]">
                  <p className="font-medium">Delete object</p>
                  <p className="text-fg-2">Kept for the retention window, then purged from every node.</p>
                </div>
                <Button variant="danger-ghost" onClick={() => setConfirmDelete(true)}>
                  <Trash2 /> Delete
                </Button>
              </div>
            )}
          </>
        ) : tab === 'replicas' ? (
          <>
          {isAdmin && cur && (
            <div className="mb-4 flex items-center justify-between gap-3 text-[13px]">
              <p className="text-fg-2">Every replica is re-hashed at least weekly (HOT objects daily).</p>
              <Button size="sm" loading={verifyNow.isPending} onClick={() => verifyNow.mutate()}>
                <ScanSearch /> Verify now
              </Button>
            </div>
          )}
          <ul className="space-y-3">
            {d.replicas.map((r) => (
              <li key={r.id} className="rounded-lg p-4 shadow-[inset_0_0_0_1px_var(--border)]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{r.nodeName}</span>
                  <NodeStatus status={r.nodeStatus} />
                  <span className="ml-auto">
                    {r.checksumMatch ? (
                      <Badge tone="good" icon>Checksum match</Badge>
                    ) : (
                      <Badge tone="bad" icon>{r.state === 'CORRUPT' ? 'Corrupt' : r.state === 'MISSING' ? 'Missing' : 'Mismatch'}</Badge>
                    )}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-1 rounded-md bg-surface-2 py-1 pr-1 pl-2.5">
                  <Mono className="flex-1 text-fg-2">{r.blobPath}</Mono>
                  <CopyButton text={r.blobPath} label="Copy path" />
                </div>
                <p className="mt-2 text-xs text-fg-3">
                  Replica state {r.state.toLowerCase()} · verified <RelativeTime iso={r.lastVerifiedAt} />
                </p>
              </li>
            ))}
          </ul>
          </>
        ) : tab === 'share' && cur ? (
          <SharePanel bucket={bucket} objectKey={key} versionNo={cur.versionNo} />
        ) : tab === 'placement' ? (
          <div>
            <p className="mb-5 text-[13px] text-fg-2">
              The placement key <Mono>bucket/key@version</Mono> hashes to a point on the ring. AegisStore walks clockwise and stores a replica on each of the first distinct healthy nodes it meets.
            </p>
            {ring.data && walk ? (
              <HashRingFigure ring={ring.data} walk={walk} markerLabel={`${(d.placement!.ringPos * 100).toFixed(1)}%`} />
            ) : (
              <Skeleton className="mx-auto size-72 rounded-full" />
            )}
            {d.placement && (
              <p className="mt-5 text-xs text-fg-3">
                Ring order from this key: {d.placement.ringOrder.join(' → ')}. Replicas go to the first healthy nodes in that order at upload time.
              </p>
            )}
          </div>
        ) : (
          <ol className="relative space-y-1 before:absolute before:top-3 before:bottom-3 before:left-[11px] before:w-px before:bg-line">
            {d.versions.map((v) => {
              const restorable = canWrite && !v.isCurrent && !v.isDeleteMarker && (v.state === 'ACTIVE' || v.state === 'DELETED');
              return (
                <li key={v.versionId} className="relative flex gap-3 rounded-lg py-2.5 pr-2 pl-0">
                  <span className={cx('relative z-[1] mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold shadow-[0_0_0_3px_var(--surface)]', v.isCurrent ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-fg-2')}>
                    {v.versionNo}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                      <span className="font-medium">{v.isDeleteMarker ? 'Delete marker' : formatBytes(v.size)}</span>
                      {v.isCurrent && <Badge tone="good">Current</Badge>}
                      {v.state === 'DELETED' && <Badge tone="warn">Deleted</Badge>}
                      {v.state === 'PURGED' && <Badge>Purged</Badge>}
                      {v.isProtected && (
                        <Tip content={`Pre-attack copy: immutable${v.protectedUntil ? ` until ${formatDateTime(v.protectedUntil)}` : ''}`}>
                          <span>
                            <Badge tone="info">
                              <Lock className="size-3" /> Protected
                            </Badge>
                          </span>
                        </Tip>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-fg-2">
                      {formatDateTime(v.createdAt)} · {v.createdBy ?? 'unknown'}
                    </p>
                    {v.state === 'DELETED' && v.purgeAfter && <p className="mt-0.5 text-xs text-warn-text">Purged from disk {relativeTime(v.purgeAfter)}</p>}
                    {v.sha256 && !v.isDeleteMarker && <Mono className="mt-1 block truncate text-fg-3">{v.sha256}</Mono>}
                    {v.entropy !== null && !v.isDeleteMarker && <p className="mt-0.5 text-xs text-fg-3">Entropy {v.entropy.toFixed(2)} bits/byte{v.entropy >= 7.5 ? ' (random-looking: compressed or encrypted)' : ''}</p>}
                  </div>
                  <div className="flex shrink-0 items-start gap-1">
                    {v.state === 'ACTIVE' && !v.isDeleteMarker && (
                      <Tip content="Download this version">
                        <a href={objectUrl(bucket, key, v.versionId)} download className={buttonStyles({ variant: 'ghost', size: 'icon-sm' })} aria-label={`Download version ${v.versionNo}`}>
                          <Download />
                        </a>
                      </Tip>
                    )}
                    {restorable && (
                      <Button size="sm" loading={restore.isPending && restore.variables === v.versionId} onClick={() => restore.mutate(v.versionId)}>
                        <RotateCcw /> Restore
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
            {d.versions.length === 0 && <p className="text-sm text-fg-2"><History className="mr-1 inline size-4" />No versions.</p>}
          </ol>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete object?"
        description={<>Delete <span className="font-medium text-fg">{key}</span>? Downloads will return 404. You can restore it from “Recently deleted” until the retention purge.</>}
        onConfirm={() => del.mutate()}
        busy={del.isPending}
        error={del.error ? <ErrorNote error={del.error} /> : null}
      />
    </Sheet>
  );
}
