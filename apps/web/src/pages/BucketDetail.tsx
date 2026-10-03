import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, Download, File as FileIcon, Globe, History, Search, Trash2, Upload, UserPlus, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, http, objectUrl, uploadObject, type BucketDto, type GrantDto, type ObjectList } from '../api';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Meter, Modal, PageHeader, Pagination, Select, Tabs, Td, Th, Toggle, classTone, integrityLabel, integrityTone, useToast } from '../components/ui';
import { cx, formatBytes, timeAgo } from '../lib/format';
import { ObjectDrawer } from './ObjectDrawer';

// ------------------------------------------------------------------------------------- upload
interface UploadItem {
  id: number;
  file: File;
  progress: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
  replicas?: string[];
}

function UploadModal({ bucket, onClose, onUploaded }: { bucket: string; onClose: () => void; onUploaded: () => void }) {
  const [prefix, setPrefix] = useState('');
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  const add = (files: FileList | File[]) =>
    setItems((s) => [...s, ...Array.from(files).map((file) => ({ id: nextId.current++, file, progress: 0, status: 'queued' as const }))]);

  const patch = (id: number, p: Partial<UploadItem>) => setItems((s) => s.map((i) => (i.id === id ? { ...i, ...p } : i)));

  const start = async () => {
    setRunning(true);
    const norm = prefix.trim().replace(/^\/+/, '');
    const keyPrefix = norm && !norm.endsWith('/') ? `${norm}/` : norm;
    for (const it of items.filter((i) => i.status === 'queued' || i.status === 'error')) {
      patch(it.id, { status: 'uploading', progress: 0, error: undefined });
      try {
        const r = await uploadObject(bucket, `${keyPrefix}${it.file.name}`, it.file, (f) => patch(it.id, { progress: f }));
        patch(it.id, { status: 'done', progress: 1, replicas: r.replicas.map((x) => x.node) });
        onUploaded();
      } catch (e) {
        patch(it.id, { status: 'error', error: e instanceof ApiError ? e.message : 'Upload failed' });
      }
    }
    setRunning(false);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) add(e.dataTransfer.files);
  };

  const pending = items.filter((i) => i.status === 'queued' || i.status === 'error').length;
  const allDone = items.length > 0 && items.every((i) => i.status === 'done');

  return (
    <Modal
      title="Upload objects"
      width="max-w-xl"
      onClose={running ? () => undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={running}>
            {allDone ? 'Close' : 'Cancel'}
          </Button>
          {!allDone && (
            <Button variant="primary" onClick={start} loading={running} disabled={pending === 0}>
              <Upload className="size-4" /> Upload {pending > 0 ? `${pending} file${pending > 1 ? 's' : ''}` : ''}
            </Button>
          )}
        </>
      }
    >
      <Field label="Folder prefix (optional)" hint='Objects are stored under this prefix, e.g. "reports/2026/"'>
        {(id) => <Input id={id} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="reports/2026/" disabled={running} />}
      </Field>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        className={cx('flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors', dragging ? 'border-brand bg-brand-soft' : 'border-border hover:border-brand/60 hover:bg-surface-2/50')}
      >
        <Upload className="size-6 text-muted" />
        <p className="text-sm font-medium">Drop files here or click to choose</p>
        <p className="text-xs text-muted">Up to 100 MB per file</p>
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && add(e.target.files)} data-testid="file-input" />
      </div>

      {items.length > 0 && (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {items.map((i) => (
            <li key={i.id} className="space-y-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2 text-sm">
                <FileIcon className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{i.file.name}</span>
                <span className="shrink-0 text-xs text-muted">{formatBytes(i.file.size)}</span>
                {i.status === 'done' && <CheckCircle2 className="size-4 shrink-0 text-ok" />}
                {i.status === 'error' && <XCircle className="size-4 shrink-0 text-bad" />}
              </div>
              {(i.status === 'uploading' || i.status === 'done') && <Meter pct={i.progress * 100} tone={i.status === 'done' ? 'ok' : 'brand'} />}
              {i.status === 'done' && <p className="text-xs text-ok">Stored on {i.replicas?.join(' + ')}</p>}
              {i.error && <p className="text-xs text-bad">{i.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------------------------ settings
function SettingsTab({ bucket }: { bucket: BucketDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [perm, setPerm] = useState<'READ' | 'WRITE' | 'ADMIN'>('READ');
  const [deleting, setDeleting] = useState(false);
  const canAdmin = bucket.permission === 'OWNER' || bucket.permission === 'ADMIN';

  const update = useMutation({
    mutationFn: (b: { versioningEnabled?: boolean; publicRead?: boolean }) => http.patch(`/api/buckets/${bucket.name}`, b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bucket', bucket.name] });
      toast('ok', 'Bucket settings saved');
    },
    onError: (e) => toast('bad', e instanceof Error ? e.message : 'Could not save'),
  });

  const grants = useQuery({
    queryKey: ['grants', bucket.name],
    queryFn: () => http.get<{ items: GrantDto[] }>(`/api/buckets/${bucket.name}/grants`),
    enabled: canAdmin,
  });
  const addGrant = useMutation({
    mutationFn: () => http.put(`/api/buckets/${bucket.name}/grants`, { email, permission: perm }),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['grants', bucket.name] });
      toast('ok', 'Access granted');
    },
  });
  const removeGrant = useMutation({
    mutationFn: (userId: string) => http.del(`/api/buckets/${bucket.name}/grants/${userId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['grants', bucket.name] }),
  });
  const delBucket = useMutation({
    mutationFn: () => http.del(`/api/buckets/${bucket.name}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['buckets'] });
      toast('ok', `Bucket "${bucket.name}" deleted`);
      navigate('/buckets');
    },
  });

  if (!canAdmin) return <Card className="p-5 text-sm text-muted">Only the bucket owner or an administrator can change settings.</Card>;

  return (
    <div className="space-y-4">
      <Card className="space-y-5 p-5">
        <h3 className="text-sm font-semibold">Settings</h3>
        <Toggle checked={bucket.versioningEnabled} onChange={(v) => update.mutate({ versioningEnabled: v })} disabled={update.isPending} label="Versioning" description="Keep previous versions when objects are overwritten; deletes create a delete marker." />
        <Toggle checked={bucket.publicRead} onChange={(v) => update.mutate({ publicRead: v })} disabled={update.isPending} label="Public read access" description="Anyone can list and download objects without signing in." />
      </Card>

      <Card>
        <div className="border-b border-border px-5 py-3.5">
          <h3 className="text-sm font-semibold">Shared access</h3>
          <p className="text-xs text-muted">Give other users READ, WRITE or ADMIN permissions on this bucket.</p>
        </div>
        <form
          className="flex flex-wrap items-end gap-2 border-b border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            addGrant.mutate();
          }}
        >
          <div className="min-w-56 flex-1">
            <Field label="User email">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" />}</Field>
          </div>
          <div className="w-32">
            <Field label="Permission">
              {(id) => (
                <Select id={id} value={perm} onChange={(e) => setPerm(e.target.value as typeof perm)}>
                  <option value="READ">Read</option>
                  <option value="WRITE">Write</option>
                  <option value="ADMIN">Admin</option>
                </Select>
              )}
            </Field>
          </div>
          <Button type="submit" variant="primary" loading={addGrant.isPending}>
            <UserPlus className="size-4" /> Grant
          </Button>
        </form>
        {addGrant.error && <div className="px-4 pt-3"><ErrorNote error={addGrant.error} /></div>}
        {grants.isLoading ? (
          <Loading />
        ) : (grants.data?.items.length ?? 0) === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">Nobody else has access yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {grants.data!.items.map((g) => (
              <li key={g.userId} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <span>
                  <span className="font-medium">{g.email}</span>
                </span>
                <span className="flex items-center gap-3">
                  <Badge tone="brand">{g.permission}</Badge>
                  <Button size="sm" variant="ghost" onClick={() => removeGrant.mutate(g.userId)} aria-label={`Remove ${g.email}`}>
                    <Trash2 className="size-4" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex items-center justify-between gap-4 border-bad/30 p-5">
        <div>
          <h3 className="text-sm font-semibold text-bad">Delete bucket</h3>
          <p className="text-xs text-muted">Only empty buckets can be deleted. This cannot be undone.</p>
        </div>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          Delete bucket
        </Button>
      </Card>

      {deleting && <ConfirmDialog title="Delete bucket" message={<>Delete <strong className="text-text">{bucket.name}</strong>?</>} busy={delBucket.isPending} error={delBucket.error} onConfirm={() => delBucket.mutate()} onClose={() => { setDeleting(false); delBucket.reset(); }} />}
    </div>
  );
}

// -------------------------------------------------------------------------------------- page
type SortKey = 'key' | 'size' | 'createdAt';

export function BucketDetailPage() {
  const { bucket: name = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'objects' | 'settings'>('objects');
  const [uploading, setUploading] = useState(false);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [integrity, setIntegrity] = useState('');
  const [cls, setCls] = useState('');
  const [sort, setSort] = useState<SortKey>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const openKey = params.get('object');

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const bucket = useQuery({ queryKey: ['bucket', name], queryFn: () => http.get<{ bucket: BucketDto }>(`/api/buckets/${name}`), retry: false });
  const objects = useQuery({
    queryKey: ['objects', name, { debouncedQ, integrity, cls, sort, order, page }],
    queryFn: () => {
      const p = new URLSearchParams({ sort, order, page: String(page), pageSize: '25' });
      if (debouncedQ) p.set('q', debouncedQ);
      if (integrity) p.set('integrity', integrity);
      if (cls) p.set('class', cls);
      return http.get<ObjectList>(`/api/buckets/${name}/objects?${p}`);
    },
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
    enabled: bucket.isSuccess,
  });

  const del = useMutation({
    mutationFn: (key: string) => http.del(objectUrl(name, key)),
    onSuccess: (_r, key) => {
      void qc.invalidateQueries({ queryKey: ['objects', name] });
      void qc.invalidateQueries({ queryKey: ['bucket', name] });
      toast('ok', `Deleted ${key}`);
      setToDelete(null);
    },
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['objects', name] });
    void qc.invalidateQueries({ queryKey: ['bucket', name] });
    void qc.invalidateQueries({ queryKey: ['buckets'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  }, [qc, name]);

  const toggleSort = (k: SortKey) => {
    if (sort === k) setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(k);
      setOrder(k === 'key' ? 'asc' : 'desc');
    }
    setPage(1);
  };
  const SortTh = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <Th className={className}>
      <button onClick={() => toggleSort(k)} className="inline-flex items-center gap-1 uppercase hover:text-text" aria-label={`Sort by ${k}`}>
        {children}
        {sort === k && (order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </Th>
  );

  if (bucket.isLoading) return <Loading />;
  if (bucket.error || !bucket.data) {
    const notFound = bucket.error instanceof ApiError && bucket.error.status === 404;
    return (
      <EmptyState
        icon={<Search className="size-5" />}
        title={notFound ? 'Bucket not found' : 'Could not load the bucket'}
        description={notFound ? 'It may have been deleted, or you may not have access to it.' : (bucket.error as Error)?.message}
        action={<Link to="/buckets"><Button>Back to buckets</Button></Link>}
      />
    );
  }

  const b = bucket.data.bucket;
  const canWrite = b.permission === 'OWNER' || b.permission === 'ADMIN' || b.permission === 'WRITE';
  const list = objects.data;
  const hasFilters = !!(debouncedQ || integrity || cls);

  return (
    <>
      <PageHeader
        back={
          <Link to="/buckets" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text">
            <ArrowLeft className="size-4" /> Buckets
          </Link>
        }
        title={b.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {b.objectCount?.toLocaleString()} objects · {formatBytes(b.totalBytes)}
            {b.versioningEnabled && <Badge tone="info"><History className="size-3" /> Versioned</Badge>}
            {b.publicRead && <Badge tone="warn"><Globe className="size-3" /> Public read</Badge>}
          </span>
        }
        actions={
          canWrite && (
            <Button variant="primary" onClick={() => setUploading(true)}>
              <Upload className="size-4" /> Upload object
            </Button>
          )
        }
      />

      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'objects', label: 'Objects', count: b.objectCount }, { id: 'settings', label: 'Settings' }]} />

      <div className="mt-4">
        {tab === 'settings' ? (
          <SettingsTab bucket={b} />
        ) : (
          <Card>
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <div className="relative min-w-56 flex-1 sm:max-w-sm">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                <Input aria-label="Search objects" placeholder="Search objects…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
              </div>
              <Select aria-label="Filter by integrity" value={integrity} onChange={(e) => { setIntegrity(e.target.value); setPage(1); }} className="w-40">
                <option value="">All integrity</option>
                <option value="HEALTHY">Healthy</option>
                <option value="DEGRADED">Degraded</option>
                <option value="UNAVAILABLE">Unavailable</option>
              </Select>
              <Select aria-label="Filter by class" value={cls} onChange={(e) => { setCls(e.target.value); setPage(1); }} className="w-36">
                <option value="">All classes</option>
                <option value="HOT">Hot</option>
                <option value="WARM">Warm</option>
                <option value="COLD">Cold</option>
              </Select>
            </div>

            {objects.isLoading ? (
              <Loading />
            ) : objects.error ? (
              <div className="p-5"><ErrorNote error={objects.error} /></div>
            ) : !list || list.items.length === 0 ? (
              <EmptyState
                icon={<FileIcon className="size-5" />}
                title={hasFilters ? 'No objects match your filters' : 'This bucket is empty'}
                description={hasFilters ? undefined : canWrite ? 'Upload a file to see it replicated across storage nodes.' : 'Nothing has been uploaded yet.'}
                action={!hasFilters && canWrite && <Button variant="primary" onClick={() => setUploading(true)}>Upload object</Button>}
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b border-border bg-surface-2/50">
                      <tr>
                        <SortTh k="key">Name</SortTh>
                        <SortTh k="size">Size</SortTh>
                        <Th>Class</Th>
                        <Th>Integrity</Th>
                        <Th>Replicas</Th>
                        <SortTh k="createdAt">Modified</SortTh>
                        <Th align="right" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {list.items.map((o) => (
                        <tr key={o.key} className="cursor-pointer hover:bg-surface-2/40" onClick={() => setParams({ object: o.key })}>
                          <Td className="max-w-xs">
                            <button className="flex max-w-full items-center gap-2 text-left font-medium hover:text-brand" onClick={(e) => { e.stopPropagation(); setParams({ object: o.key }); }}>
                              <FileIcon className="size-4 shrink-0 text-muted" />
                              <span className="truncate">{o.key}</span>
                            </button>
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums">{formatBytes(o.size)}</Td>
                          <Td><Badge tone={classTone(o.storageClass)}>{o.storageClass}</Badge></Td>
                          <Td><Badge tone={integrityTone(o.integrity)} dot>{integrityLabel(o.integrity)}</Badge></Td>
                          <Td className="tabular-nums text-muted">{o.availableReplicas}/{o.targetReplicas}</Td>
                          <Td className="whitespace-nowrap text-muted">{timeAgo(o.createdAt)}</Td>
                          <Td align="right">
                            <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                              <a href={objectUrl(name, o.key)} download aria-label={`Download ${o.key}`}>
                                <Button variant="ghost" size="sm" tabIndex={-1}><Download className="size-4" /></Button>
                              </a>
                              {canWrite && (
                                <Button variant="ghost" size="sm" onClick={() => setToDelete(o.key)} aria-label={`Delete ${o.key}`}>
                                  <Trash2 className="size-4" />
                                </Button>
                              )}
                            </div>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={list.page} pageSize={list.pageSize} total={list.total} onPage={setPage} />
              </>
            )}
          </Card>
        )}
      </div>

      {uploading && <UploadModal bucket={name} onClose={() => setUploading(false)} onUploaded={refresh} />}
      {openKey && <ObjectDrawer bucket={name} objectKey={openKey} canWrite={canWrite} onClose={() => setParams({})} />}
      {toDelete && (
        <ConfirmDialog
          title="Delete object"
          message={<>Delete <strong className="text-text">{toDelete}</strong>?</>}
          busy={del.isPending}
          error={del.error}
          onConfirm={() => del.mutate(toDelete)}
          onClose={() => { setToDelete(null); del.reset(); }}
        />
      )}
    </>
  );
}
