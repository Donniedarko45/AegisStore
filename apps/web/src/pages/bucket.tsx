import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronRight, Database, Download, File as FileIcon, Flame, FolderOpen, FolderUp, Globe, History, Lock, RotateCcw, Search, ShieldAlert, Snowflake, ThermometerSun, Trash2, Upload, UserPlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useUploads } from '../components/app/uploads';
import { Button, buttonStyles } from '../components/ui/button';
import { ConfirmDialog, SelectBox, SwitchField, TabsBar, Tip } from '../components/ui/overlays';
import { Avatar, Badge, Card, CardHeader, EmptyState, ErrorNote, Input, integrityLabel, integrityTone, PageHeader, RelativeTime, Skeleton, Td, Th } from '../components/ui/primitives';
import { ApiError, http, objectUrl, type BucketDto, type DeletedObject, type GrantDto, type ObjectList } from '../lib/api';
import { cx, formatBytes, middleTruncate, plural, relativeTime } from '../lib/format';
import { usePollInterval } from '../lib/queries';
import { ObjectSheet } from './object-sheet';

type Tab = 'objects' | 'deleted' | 'access' | 'settings';
type Sort = 'key' | 'size' | 'createdAt';

// ------------------------------------------------------------------------------- drop target
/** Page-wide drop target: the overlay fades in only while files are dragged over the window. */
function useWindowDrop(onFiles: (files: File[]) => void, enabled: boolean) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setActive(true);
    };
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.size > 0 || f.type !== '');
      if (files.length) onFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [onFiles, enabled]);
  return active;
}

// ------------------------------------------------------------------------------------ objects
function ObjectsTab({ bucket, canWrite }: { bucket: BucketDto; canWrite: boolean }) {
  const [params, setParams] = useSearchParams();
  const prefix = params.get('prefix') ?? '';
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [integrity, setIntegrity] = useState<'all' | 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE'>('all');
  const [klass, setKlass] = useState<'all' | 'HOT' | 'WARM' | 'COLD'>('all');
  const [sort, setSort] = useState<Sort>('key');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const add = useUploads((s) => s.add);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const refetchInterval = usePollInterval(10_000, 60_000);

  useEffect(() => {
    const t = setTimeout(() => {
      setDq(q.trim());
      setPage(1);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(1), [prefix, integrity, klass, sort, order]);

  const searching = dq.length > 0;
  const list = useQuery({
    queryKey: ['objects', bucket.name, { prefix, dq, integrity, klass, sort, order, page }],
    queryFn: () => {
      const p = new URLSearchParams({ sort, order, page: String(page), pageSize: '50' });
      if (searching) p.set('q', dq);
      else {
        p.set('delimiter', '/');
        if (prefix) p.set('prefix', prefix);
      }
      if (integrity !== 'all') p.set('integrity', integrity);
      if (klass !== 'all') p.set('class', klass);
      return http.get<ObjectList>(`/api/buckets/${encodeURIComponent(bucket.name)}/objects?${p}`);
    },
    placeholderData: keepPreviousData,
    refetchInterval,
  });

  const openObject = (key: string) => setParams((p) => { p.set('object', key); return p; });
  const goPrefix = (p: string) => setParams((s) => { if (p) s.set('prefix', p); else s.delete('prefix'); s.delete('object'); return s; });
  const onFiles = (files: File[]) => add(bucket.name, prefix, files);
  const dragging = useWindowDrop(onFiles, canWrite);

  const crumbs = prefix.split('/').filter(Boolean);
  const data = list.data;
  const empty = data && data.items.length === 0 && (data.prefixes?.length ?? 0) === 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const sortBy = (k: Sort) => {
    if (sort === k) setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(k);
      setOrder(k === 'key' ? 'asc' : 'desc');
    }
  };
  const SortHead = ({ k, children, align }: { k: Sort; children: React.ReactNode; align?: 'right' }) => (
    <Th align={align}>
      <button onClick={() => sortBy(k)} className={cx('inline-flex items-center gap-1 hover:text-fg', sort === k && 'text-fg')}>
        {children}
        {sort === k ? order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
      </button>
    </Th>
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <nav aria-label="Folder" className="flex min-w-0 basis-full items-center gap-0.5 overflow-hidden text-sm whitespace-nowrap sm:basis-auto sm:flex-1">
          <button onClick={() => goPrefix('')} title={bucket.name} className={cx('pressable max-w-[11rem] shrink-0 truncate rounded-md px-1.5 py-1 hover:bg-surface-2', !prefix && 'font-medium')}>
            {bucket.name}
          </button>
          {/* deep paths collapse their middle segments so the current folder stays visible */}
          {(crumbs.length > 3 ? [{ label: '…', depth: crumbs.length - 3, ellipsis: true }, ...crumbs.slice(-2).map((c, i) => ({ label: c, depth: crumbs.length - 2 + i, ellipsis: false }))] : crumbs.map((c, i) => ({ label: c, depth: i, ellipsis: false }))).map(({ label, depth, ellipsis }) => {
            const p = `${crumbs.slice(0, depth + 1).join('/')}/`;
            const last = depth === crumbs.length - 1;
            return (
              <span key={p} className={cx('flex items-center gap-0.5', last ? 'min-w-0' : 'shrink-0')}>
                <ChevronRight className="size-3.5 shrink-0 text-fg-3" />
                <button onClick={() => goPrefix(p)} title={ellipsis ? p : label} className={cx('pressable truncate rounded-md px-1.5 py-1 hover:bg-surface-2', last ? 'max-w-full font-medium' : 'max-w-[8rem]')}>
                  {label}
                </button>
              </span>
            );
          })}
        </nav>
        {canWrite && (
          <>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) onFiles(Array.from(e.target.files)); e.target.value = ''; }} data-testid="file-input" />
            <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: '' } as object)} onChange={(e) => { if (e.target.files) onFiles(Array.from(e.target.files)); e.target.value = ''; }} />
            <Tip content="Upload a folder"><Button size="icon" onClick={() => folderInput.current?.click()} aria-label="Upload folder"><FolderUp /></Button></Tip>
            <Button variant="primary" onClick={() => fileInput.current?.click()}><Upload /> Upload</Button>
          </>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
          <Input aria-label="Search objects" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search all of ${bucket.name}…`} className="pl-8 pr-8" />
          {q && (
            <button onClick={() => setQ('')} className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-fg-3 hover:text-fg" aria-label="Clear search">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <SelectBox
          label="Filter by integrity"
          value={integrity}
          onChange={setIntegrity}
          className="w-44"
          options={[
            { value: 'all', label: 'All integrity' },
            { value: 'HEALTHY', label: 'Healthy' },
            { value: 'DEGRADED', label: 'Degraded' },
            { value: 'UNAVAILABLE', label: 'Unavailable' },
          ]}
        />
        <SelectBox
          label="Filter by access class"
          value={klass}
          onChange={setKlass}
          className="w-36"
          options={[
            { value: 'all', label: 'All classes' },
            { value: 'HOT', label: 'Hot' },
            { value: 'WARM', label: 'Warm' },
            { value: 'COLD', label: 'Cold' },
          ]}
        />
      </div>

      <Card className="overflow-hidden">
        {list.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>
        ) : list.error ? (
          <div className="p-4"><ErrorNote error={list.error} /></div>
        ) : empty ? (
          <EmptyState
            icon={searching ? <Search /> : <FolderOpen />}
            title={searching ? `Nothing matches “${dq}”` : klass !== 'all' ? `No ${klass.toLowerCase()} objects here` : integrity !== 'all' ? `No ${integrityLabel(integrity).toLowerCase()} objects here` : prefix ? 'This folder is empty' : 'This bucket is empty'}
            description={canWrite && !searching ? 'Drop files anywhere on this page, or use Upload.' : undefined}
            action={canWrite && !searching && <Button variant="primary" onClick={() => fileInput.current?.click()}><Upload /> Upload files</Button>}
          />
        ) : (
          <div className={cx('relative overflow-x-auto transition-opacity duration-200 ease-[ease]', list.isFetching && list.isPlaceholderData && 'opacity-60')}>
            <table className="w-full min-w-[800px]">
              <thead className="border-b border-line">
                <tr>
                  <SortHead k="key">Name</SortHead>
                  <SortHead k="size" align="right">Size</SortHead>
                  <Th>Integrity</Th>
                  <Th>Class</Th>
                  <Th>Replicas</Th>
                  <SortHead k="createdAt">Modified</SortHead>
                  <Th align="right"><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {!searching &&
                  data!.prefixes.map((p) => (
                    <tr key={p.prefix} className="cursor-pointer transition-colors duration-150 hover:bg-surface-2/60" onClick={() => goPrefix(p.prefix)}>
                      <Td>
                        <span className="flex items-center gap-2.5 font-medium">
                          <FolderOpen className="size-4 shrink-0 text-fg-3" />
                          {p.prefix.slice(prefix.length)}
                        </span>
                      </Td>
                      <Td align="right" className="text-fg-2 tabular-nums">{formatBytes(p.bytes)}</Td>
                      <Td className="text-fg-3">—</Td>
                      <Td className="text-fg-3">—</Td>
                      <Td className="text-fg-2">{plural(p.objects, 'object', 'objects')}</Td>
                      <Td className="text-fg-3">—</Td>
                      <Td />
                    </tr>
                  ))}
                {data!.items.map((o) => {
                  const name = searching ? o.key : o.key.slice(prefix.length);
                  return (
                    <tr key={o.key} className="group cursor-pointer transition-colors duration-150 hover:bg-surface-2/60" onClick={() => openObject(o.key)}>
                      <Td className="max-w-[380px]">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <FileIcon className="size-4 shrink-0 text-fg-3" />
                          <span className="truncate" title={o.key}>{middleTruncate(name, 64)}</span>
                        </span>
                      </Td>
                      <Td align="right" className="whitespace-nowrap tabular-nums">{formatBytes(o.size)}</Td>
                      <Td><Badge tone={integrityTone(o.integrity)} icon>{integrityLabel(o.integrity)}</Badge></Td>
                      <Td>
                        <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-2">
                          {o.storageClass === 'HOT' ? <Flame className="size-3.5" /> : o.storageClass === 'COLD' ? <Snowflake className="size-3.5" /> : <ThermometerSun className="size-3.5" />}
                          {o.storageClass.charAt(0) + o.storageClass.slice(1).toLowerCase()}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex items-center gap-1" aria-label={`${o.availableReplicas} of ${o.targetReplicas} replicas available`}>
                          {Array.from({ length: o.targetReplicas }, (_, i) => (
                            // a HOT object's extra copy still being made is not a fault: neutral, not red
                            <span key={i} className={cx('h-3 w-1.5 rounded-sm', i < o.availableReplicas ? 'bg-good' : o.integrity === 'HEALTHY' ? 'bg-surface-3' : 'bg-bad')} />
                          ))}
                          <span className="ml-1 text-xs text-fg-2 tabular-nums">{o.availableReplicas}/{o.targetReplicas}</span>
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap text-fg-2"><RelativeTime iso={o.createdAt} /></Td>
                      <Td align="right">
                        <span className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                          <Tip content="Download">
                            <a href={objectUrl(bucket.name, o.key)} download className={buttonStyles({ variant: 'ghost', size: 'icon-sm' })} aria-label={`Download ${o.key}`}>
                              <Download />
                            </a>
                          </Tip>
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > data.pageSize && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[13px] text-fg-2">
            <span className="tabular-nums">
              {((data.page - 1) * data.pageSize + 1).toLocaleString()}–{Math.min(data.total, data.page * data.pageSize).toLocaleString()} of {data.total.toLocaleString()}
            </span>
            <span className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
            </span>
          </div>
        )}
      </Card>

      {/* drop overlay: fades in while dragging files over the window */}
      <div
        aria-hidden={!dragging}
        className={cx('pointer-events-none fixed inset-0 z-50 grid place-items-center bg-[var(--bg)]/70 p-6 backdrop-blur-sm transition-opacity duration-150 ease-out', dragging ? 'opacity-100' : 'opacity-0')}
      >
        <div className={cx('flex h-full w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[var(--series-1)] text-center transition-transform duration-200 ease-out', dragging ? 'scale-100' : 'scale-[0.98]')}>
          <Upload className="size-8 text-[var(--series-1)]" />
          <p className="mt-3 text-lg font-semibold">Drop to upload</p>
          <p className="mt-1 text-sm text-fg-2">
            into <span className="font-mono">{bucket.name}/{prefix}</span>
          </p>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------ recently deleted
function DeletedTab({ bucket, canWrite }: { bucket: BucketDto; canWrite: boolean }) {
  const qc = useQueryClient();
  const del = useQuery({ queryKey: ['deleted', bucket.name], queryFn: () => http.get<{ items: DeletedObject[] }>(`/api/buckets/${encodeURIComponent(bucket.name)}/objects/deleted`) });
  const restore = useMutation({
    mutationFn: (o: DeletedObject) => http.post(`/api/buckets/${encodeURIComponent(bucket.name)}/object/restore?key=${encodeURIComponent(o.key)}&versionId=${o.versionId}`),
    onSuccess: (_r, o) => {
      void qc.invalidateQueries({ queryKey: ['deleted', bucket.name] });
      void qc.invalidateQueries({ queryKey: ['objects', bucket.name] });
      void qc.invalidateQueries({ queryKey: ['bucket', bucket.name] });
      toast.success(`Restored ${o.key}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Restore failed'),
  });
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Recently deleted" description={bucket.versioningEnabled ? 'Deleted objects keep their full version history until you restore them.' : 'Deleted and overwritten data stays recoverable until the retention purge removes it from every node.'} />
      {del.isLoading ? (
        <div className="p-4"><Skeleton className="h-24" /></div>
      ) : !del.data?.items.length ? (
        <EmptyState icon={<Trash2 />} title="Nothing deleted recently" description="Deleted objects appear here while they can still be restored." />
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead className="border-y border-line">
              <tr><Th>Name</Th><Th align="right">Size</Th><Th>Deleted</Th><Th>Purged from disk</Th><Th align="right"><span className="sr-only">Actions</span></Th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {del.data.items.map((o) => (
                <tr key={o.key}>
                  <Td className="max-w-[360px]"><span className="flex items-center gap-2.5"><FileIcon className="size-4 shrink-0 text-fg-3" /><span className="truncate" title={o.key}>{o.key}</span></span></Td>
                  <Td align="right" className="tabular-nums">{formatBytes(o.size)}</Td>
                  <Td className="text-fg-2"><RelativeTime iso={o.deletedAt} /></Td>
                  <Td>{o.purgeAfter ? <span className="text-warn-text">{relativeTime(o.purgeAfter)}</span> : <span className="text-fg-3">kept (versioned)</span>}</Td>
                  <Td align="right">
                    {canWrite && (
                      <Button size="sm" onClick={() => restore.mutate(o)} loading={restore.isPending && restore.variables?.key === o.key}>
                        <RotateCcw /> Restore
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------------------- access
function AccessTab({ bucket, canAdmin }: { bucket: BucketDto; canAdmin: boolean }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [perm, setPerm] = useState<'READ' | 'WRITE' | 'ADMIN'>('READ');
  const grants = useQuery({ queryKey: ['grants', bucket.name], queryFn: () => http.get<{ items: GrantDto[] }>(`/api/buckets/${encodeURIComponent(bucket.name)}/grants`), enabled: canAdmin });
  const patch = useMutation({
    mutationFn: (b: { publicRead?: boolean; versioningEnabled?: boolean }) => http.patch(`/api/buckets/${encodeURIComponent(bucket.name)}`, b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bucket', bucket.name] });
      toast.success('Saved');
    },
  });
  const add = useMutation({
    mutationFn: (b: { email: string; permission: string }) => http.put(`/api/buckets/${encodeURIComponent(bucket.name)}/grants`, b),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['grants', bucket.name] });
      toast.success('Access updated');
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => http.del(`/api/buckets/${encodeURIComponent(bucket.name)}/grants/${userId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['grants', bucket.name] }),
  });
  if (!canAdmin) return <Card className="p-6 text-sm text-fg-2">Only the owner or a bucket admin can manage access.</Card>;
  const permOptions = [
    { value: 'READ' as const, label: 'Can read' },
    { value: 'WRITE' as const, label: 'Can write' },
    { value: 'ADMIN' as const, label: 'Can manage' },
  ];
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <SwitchField
          checked={bucket.publicRead}
          onChange={(v) => patch.mutate({ publicRead: v })}
          disabled={patch.isPending}
          label="Public read"
          description={bucket.publicRead ? 'Anyone with a link can list and download objects.' : 'Only people listed below (and administrators) can see this bucket.'}
        />
      </Card>
      <Card>
        <CardHeader title="People with access" description="Grant other users read, write or manage permission." />
        <form
          className="flex flex-wrap items-center gap-2 border-y border-line px-5 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) add.mutate({ email: email.trim(), permission: perm });
          }}
        >
          <Input type="email" required aria-label="Email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-56 flex-1" />
          <SelectBox label="Permission" value={perm} onChange={setPerm} options={permOptions} className="w-36" />
          <Button type="submit" variant="primary" loading={add.isPending}><UserPlus /> Invite</Button>
        </form>
        {add.error && <div className="px-5 pt-3"><ErrorNote error={add.error} /></div>}
        <ul className="divide-y divide-line">
          <li className="flex items-center gap-3 px-5 py-3">
            <Avatar email={bucket.ownerEmail} size={30} />
            <span className="min-w-0 flex-1 truncate text-sm">{bucket.ownerEmail}</span>
            <Badge>Owner</Badge>
          </li>
          {(grants.data?.items ?? []).map((g) => (
            <li key={g.userId} className="flex items-center gap-3 px-5 py-3">
              <Avatar name={g.name} email={g.email} size={30} />
              <span className="min-w-0 flex-1 truncate text-sm">{g.email}</span>
              <SelectBox size="sm" label={`Permission for ${g.email}`} value={g.permission} onChange={(v) => add.mutate({ email: g.email, permission: v })} options={permOptions} className="w-32" />
              <Tip content="Remove access">
                <Button variant="ghost" size="icon-sm" onClick={() => remove.mutate(g.userId)} aria-label={`Remove ${g.email}`}><X /></Button>
              </Tip>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------------------------- settings
function SettingsTab({ bucket, isOwner }: { bucket: BucketDto; isOwner: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const patch = useMutation({
    mutationFn: (b: { versioningEnabled?: boolean; protectedMode?: boolean; autoLock?: boolean }) => http.patch(`/api/buckets/${encodeURIComponent(bucket.name)}`, b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bucket', bucket.name] });
      void qc.invalidateQueries({ queryKey: ['security'] });
      toast.success('Saved');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  });
  const del = useMutation({
    mutationFn: () => http.del(`/api/buckets/${encodeURIComponent(bucket.name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['buckets'] });
      toast.success(`Deleted ${bucket.name}`);
      navigate('/buckets');
    },
  });
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <SwitchField
          checked={bucket.versioningEnabled}
          onChange={(v) => patch.mutate({ versioningEnabled: v })}
          disabled={patch.isPending}
          label="Versioning"
          description="Keep every version when objects are overwritten. Deleting creates a marker instead of removing data."
        />
      </Card>
      <Card>
        <CardHeader title="Ransomware protection" description="Every write and delete is watched for mass deletion, encrypted overwrites and ransomware file names. On a high-severity alert, every pre-attack version is protected for 30 days." />
        <div className="space-y-5 border-t border-line px-5 py-4">
          <SwitchField
            checked={bucket.autoLock}
            onChange={(v) => patch.mutate({ autoLock: v })}
            disabled={patch.isPending}
            label="Lock automatically on attack"
            description="Also lock the bucket the moment an attack is detected, so the attacker cannot delete or overwrite anything else. Turning this off needs a signed-in session."
          />
          <SwitchField
            checked={bucket.protectedMode}
            onChange={(v) => patch.mutate({ protectedMode: v })}
            disabled={patch.isPending}
            label="Locked"
            description={bucket.protectedMode ? 'Deletes and overwrites are refused (new objects can still be added). Unlocking needs a signed-in session, and an administrator while an alert is open.' : 'Lock now to freeze existing data, e.g. while you investigate.'}
          />
        </div>
      </Card>
      <Card className="shadow-[0_0_0_1px_var(--bad-soft)]">
        <CardHeader title="Delete bucket" description="Permanently delete this bucket. It must contain no objects. This cannot be undone." />
        <div className="flex items-center justify-between gap-4 border-t border-line bg-bad-soft/40 px-5 py-3">
          <p className="text-[13px] text-fg-2">{isOwner ? `${plural(bucket.objectCount ?? 0, 'object', 'objects')} in this bucket.` : 'Only the bucket owner can delete it.'}</p>
          <Button variant="danger" disabled={!isOwner} onClick={() => setConfirm(true)}><Trash2 /> Delete</Button>
        </div>
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => { setConfirm(o); if (!o) del.reset(); }}
        title="Delete bucket"
        description="This permanently deletes the bucket. Data still held for recovery will be purged."
        confirmText={bucket.name}
        confirmLabel="Delete bucket"
        onConfirm={() => del.mutate()}
        busy={del.isPending}
        error={del.error ? <ErrorNote error={del.error} /> : null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------- page
export function BucketPage() {
  const { bucket: name = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'objects';
  const setTab = (t: Tab) => setParams((p) => { if (t === 'objects') p.delete('tab'); else p.set('tab', t); return p; });
  const objectKey = params.get('object');
  const b = useQuery({ queryKey: ['bucket', name], queryFn: () => http.get<{ bucket: BucketDto }>(`/api/buckets/${encodeURIComponent(name)}`), retry: false });

  if (b.isLoading) return <Skeleton className="h-40 rounded-xl" />;
  if (b.error || !b.data) {
    const notFound = b.error instanceof ApiError && b.error.status === 404;
    return (
      <EmptyState
        icon={<Database />}
        title={notFound ? 'Bucket not found' : 'Could not load this bucket'}
        description={notFound ? 'It may have been deleted, or you do not have access to it.' : (b.error as Error)?.message}
        action={<Link to="/buckets" className={buttonStyles()}>Back to buckets</Link>}
      />
    );
  }
  const bucket = b.data.bucket;
  const isOwner = bucket.permission === 'OWNER';
  const canAdmin = isOwner || bucket.permission === 'ADMIN';
  const canWrite = canAdmin || bucket.permission === 'WRITE';

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/buckets" className="hover:text-fg">Buckets</Link>}
        title={bucket.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="tabular-nums">{plural(bucket.objectCount ?? 0, 'object', 'objects')} · {formatBytes(bucket.totalBytes)}</span>
            {bucket.publicRead ? <Badge tone="warn"><Globe className="size-3" /> Public read</Badge> : <Badge><Lock className="size-3" /> Private</Badge>}
            {bucket.versioningEnabled && <Badge tone="info"><History className="size-3" /> Versioned</Badge>}
            {bucket.protectedMode && <Badge tone="bad"><ShieldAlert className="size-3" /> Locked</Badge>}
            {!canWrite && <Badge>Read only</Badge>}
          </span>
        }
      />
      {bucket.protectedMode && (
        <div className="mb-5 flex items-start gap-3 rounded-lg bg-bad-soft p-3.5 text-[13px] text-bad-text">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">This bucket is locked</p>
            <p className="opacity-90">Deleting or overwriting objects is refused with “423 Locked”, usually after suspicious activity. New uploads and downloads still work.{canAdmin && ' Unlock it in Settings once the incident is resolved.'}</p>
          </div>
        </div>
      )}
      <TabsBar
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'objects', label: 'Objects' },
          { value: 'deleted', label: 'Recently deleted' },
          ...(canAdmin ? [{ value: 'access' as const, label: 'Access' }, { value: 'settings' as const, label: 'Settings' }] : []),
        ]}
      />
      {tab === 'objects' && <ObjectsTab bucket={bucket} canWrite={canWrite} />}
      {tab === 'deleted' && <DeletedTab bucket={bucket} canWrite={canWrite} />}
      {tab === 'access' && <AccessTab bucket={bucket} canAdmin={canAdmin} />}
      {tab === 'settings' && <SettingsTab bucket={bucket} isOwner={isOwner || false} />}
      <ObjectSheet bucket={bucket.name} objectKey={objectKey} canWrite={canWrite} onClose={() => setParams((p) => { p.delete('object'); return p; })} />
    </>
  );
}
