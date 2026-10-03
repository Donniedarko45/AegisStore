import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, History, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { HashRingFigure, walkRing } from '../components/figures/hash-ring';
import { Button, buttonStyles } from '../components/ui/button';
import { ConfirmDialog, Sheet, TabsBar, Tip } from '../components/ui/overlays';
import { Badge, CopyButton, ErrorNote, integrityLabel, integrityTone, Mono, NodeStatus, RelativeTime, Skeleton } from '../components/ui/primitives';
import { http, objectUrl, type ObjectDetails, type RingData } from '../lib/api';
import { cx, formatBytes, formatDateTime, relativeTime } from '../lib/format';

type Tab = 'overview' | 'replicas' | 'placement' | 'versions';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4 py-3 text-[13px]">
      <dt className="text-fg-2">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function ObjectSheet({ bucket, objectKey, canWrite, onClose }: { bucket: string; objectKey: string | null; canWrite: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
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
                        ? 'Every replica matches the SHA-256 recorded at upload.'
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
                    </div>
                    <p className="mt-0.5 text-xs text-fg-2">
                      {formatDateTime(v.createdAt)} · {v.createdBy ?? 'unknown'}
                    </p>
                    {v.state === 'DELETED' && v.purgeAfter && <p className="mt-0.5 text-xs text-warn-text">Purged from disk {relativeTime(v.purgeAfter)}</p>}
                    {v.sha256 && !v.isDeleteMarker && <Mono className="mt-1 block truncate text-fg-3">{v.sha256}</Mono>}
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
