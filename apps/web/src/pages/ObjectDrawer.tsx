import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { http, objectUrl, type ObjectDetails } from '../api';
import { Badge, Button, ConfirmDialog, Drawer, ErrorNote, Loading, Mono, Tabs, Td, Th, classTone, CopyButton, integrityLabel, integrityTone, nodeTone, useToast } from '../components/ui';
import { formatBytes, formatDate, timeAgo } from '../lib/format';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-2.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="col-span-2 min-w-0">{children}</dd>
    </div>
  );
}

export function ObjectDrawer({ bucket, objectKey, canWrite, onClose }: { bucket: string; objectKey: string; canWrite: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'overview' | 'replicas' | 'versions'>('overview');
  const [confirm, setConfirm] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ['object', bucket, objectKey],
    queryFn: () => http.get<ObjectDetails>(`/api/buckets/${bucket}/object/details?key=${encodeURIComponent(objectKey)}`),
    refetchInterval: 5000,
  });

  const del = useMutation({
    mutationFn: () => http.del(objectUrl(bucket, objectKey)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['objects', bucket] });
      void qc.invalidateQueries({ queryKey: ['buckets'] });
      toast('ok', `Deleted ${objectKey}`);
      onClose();
    },
  });

  const cur = data?.current;
  return (
    <Drawer
      title={objectKey.split('/').pop() ?? objectKey}
      subtitle={<span className="font-mono">{bucket}/{objectKey}</span>}
      onClose={onClose}
      actions={
        <>
          {cur && (
            <a href={objectUrl(bucket, objectKey)} download>
              <Button size="sm" variant="primary">
                <Download className="size-4" /> Download
              </Button>
            </a>
          )}
          {canWrite && cur && (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label="Delete object">
              <Trash2 className="size-4 text-bad" />
            </Button>
          )}
        </>
      }
    >
      {isLoading ? (
        <Loading />
      ) : error || !data ? (
        <div className="p-5">
          <ErrorNote error={error ?? 'Object not found'} />
        </div>
      ) : (
        <div className="space-y-4 p-5">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'replicas', label: 'Replicas', count: data.replicas.length },
              { id: 'versions', label: 'Versions', count: data.versions.length },
            ]}
          />

          {tab === 'overview' && (
            <>
              {cur ? (
                <dl className="divide-y divide-border">
                  <Row label="Size">{formatBytes(cur.size)} <span className="text-muted">({cur.size.toLocaleString()} bytes)</span></Row>
                  <Row label="Content type">{cur.contentType}</Row>
                  <Row label="SHA-256">
                    <div className="flex items-start gap-2">
                      <Mono className="flex-1">{cur.sha256}</Mono>
                      <CopyButton text={cur.sha256} />
                    </div>
                  </Row>
                  <Row label="Integrity">
                    <Badge tone={integrityTone(cur.integrity)} dot>
                      {integrityLabel(cur.integrity)}
                    </Badge>
                    <span className="ml-2 text-xs text-muted">
                      {data.replicas.filter((r) => r.state === 'HEALTHY' && r.nodeStatus !== 'OFFLINE').length} of {cur.targetReplicas} replicas available
                    </span>
                  </Row>
                  <Row label="Storage class">
                    <Badge tone={classTone(cur.storageClass)}>{cur.storageClass}</Badge>
                  </Row>
                  <Row label="Version">v{cur.versionNo}</Row>
                  <Row label="Created">{formatDate(cur.createdAt)}</Row>
                </dl>
              ) : (
                <p className="text-sm text-muted">This object has no current version (it was deleted).</p>
              )}
              {cur?.integrity === 'DEGRADED' && (
                <div className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-sm text-warn">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  <span>Some replicas are unavailable. The object can still be downloaded from a healthy replica.</span>
                </div>
              )}
            </>
          )}

          {tab === 'replicas' && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full">
                <thead className="border-b border-border bg-surface-2/50">
                  <tr>
                    <Th>Node</Th>
                    <Th>State</Th>
                    <Th>Checksum</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.replicas.map((r) => (
                    <tr key={r.id}>
                      <Td>
                        <div className="font-medium">{r.nodeName}</div>
                        <Badge tone={nodeTone(r.nodeStatus)} dot>
                          {r.nodeStatus.replace('_', ' ')}
                        </Badge>
                        <div className="mt-1.5">
                          <Mono className="text-muted">{r.blobPath}</Mono>
                        </div>
                      </Td>
                      <Td>
                        <Badge tone={r.state === 'HEALTHY' ? 'ok' : r.state === 'PENDING' ? 'info' : 'bad'}>{r.state}</Badge>
                        <div className="mt-1 text-xs text-muted">verified {timeAgo(r.lastVerifiedAt)}</div>
                      </Td>
                      <Td>
                        {r.checksumMatch ? (
                          <span className="inline-flex items-center gap-1 text-ok">
                            <CheckCircle2 className="size-4" /> Match
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-bad">
                            <XCircle className="size-4" /> Mismatch
                          </span>
                        )}
                      </Td>
                    </tr>
                  ))}
                  {data.replicas.length === 0 && (
                    <tr>
                      <Td className="text-muted">No replicas recorded.</Td>
                      <Td />
                      <Td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'versions' && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {data.versions.map((v) => (
                <li key={v.versionId} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      v{v.versionNo}
                      {v.isCurrent && <Badge tone="ok">Current</Badge>}
                      {v.isDeleteMarker && <Badge tone="neutral">Delete marker</Badge>}
                      {v.state === 'DELETED' && <Badge tone="bad">Deleted</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {formatDate(v.createdAt)} · {v.createdBy ?? 'unknown'} · {formatBytes(v.size)}
                    </div>
                  </div>
                  {v.state === 'ACTIVE' && !v.isDeleteMarker && (
                    <a href={objectUrl(bucket, objectKey, v.versionId)} download className="text-sm text-brand hover:underline">
                      Download
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title="Delete object"
          message={
            <>
              Delete <strong className="text-text">{objectKey}</strong>? It will disappear from the bucket and downloads will return 404.
            </>
          }
          busy={del.isPending}
          error={del.error}
          onConfirm={() => del.mutate()}
          onClose={() => setConfirm(false)}
        />
      )}
    </Drawer>
  );
}
