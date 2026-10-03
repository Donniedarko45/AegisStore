import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Globe, History, LayoutGrid, List, Lock, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Modal, Segmented, SelectBox, SwitchField } from '../components/ui/overlays';
import { Badge, Card, EmptyState, ErrorNote, Field, Input, PageHeader, RelativeTime, Skeleton, Td, Th } from '../components/ui/primitives';
import { http, type BucketDto } from '../lib/api';
import { cx, formatBytes, plural } from '../lib/format';

function CreateBucket({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('');
  const [versioning, setVersioning] = useState(false);
  const [publicRead, setPublicRead] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const valid = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(name);
  const create = useMutation({
    mutationFn: () => http.post<{ bucket: BucketDto }>('/api/buckets', { name, versioningEnabled: versioning, publicRead }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['buckets'] });
      toast.success(`Created ${r.bucket.name}`);
      onOpenChange(false);
      navigate(`/buckets/${encodeURIComponent(r.bucket.name)}`);
    },
  });
  useEffect(() => {
    if (open) {
      setName('');
      setVersioning(false);
      setPublicRead(false);
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) create.mutate();
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create a bucket"
      description="Buckets hold objects. Every object is replicated to two nodes."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-bucket" disabled={!valid} loading={create.isPending}>
            Create bucket
          </Button>
        </>
      }
    >
      <form id="create-bucket" onSubmit={submit} className="space-y-5">
        <Field label="Name" hint="3–63 characters: lowercase letters, numbers and hyphens." error={name && !valid ? 'Use lowercase letters, numbers and hyphens; start and end with a letter or number.' : null}>
          {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} placeholder="research-data" spellCheck={false} autoComplete="off" />}
        </Field>
        <SwitchField checked={versioning} onChange={setVersioning} label="Versioning" description="Keep every version on overwrite; deletes leave a restorable marker." />
        <SwitchField checked={publicRead} onChange={setPublicRead} label="Public read" description="Anyone with a link can list and download. Writes still require access." />
        <ErrorNote error={create.error} />
      </form>
    </Modal>
  );
}

type Sort = 'recent' | 'name' | 'size' | 'objects';

export function BucketsPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('buckets-view') as 'grid' | 'list') ?? 'grid');
  const creating = params.get('new') === '1';
  const setCreating = (o: boolean) => setParams(o ? { new: '1' } : {}, { replace: true });
  const { data, isLoading, error, isFetching } = useQuery({ queryKey: ['buckets', ''], queryFn: () => http.get<{ items: BucketDto[] }>('/api/buckets?q=') });

  useEffect(() => {
    try {
      localStorage.setItem('buckets-view', view);
    } catch {
      /* private mode */
    }
  }, [view]);

  const items = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = (data?.items ?? []).filter((b) => !term || b.name.includes(term));
    const by: Record<Sort, (a: BucketDto, b: BucketDto) => number> = {
      recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
      name: (a, b) => a.name.localeCompare(b.name),
      size: (a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0),
      objects: (a, b) => (b.objectCount ?? 0) - (a.objectCount ?? 0),
    };
    return list.sort(by[sort]);
  }, [data, q, sort]);

  return (
    <>
      <PageHeader
        title="Buckets"
        description={data ? `${plural(data.items.length, 'bucket', 'buckets')} you can access.` : 'Containers for your objects.'}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> Create bucket
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
          <Input aria-label="Search buckets" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search buckets…" className="pl-8" />
        </div>
        <SelectBox
          label="Sort buckets"
          value={sort}
          onChange={setSort}
          className="w-44"
          options={[
            { value: 'recent', label: 'Sort by: Newest' },
            { value: 'name', label: 'Sort by: Name' },
            { value: 'size', label: 'Sort by: Size' },
            { value: 'objects', label: 'Sort by: Objects' },
          ]}
        />
        <Segmented
          label="Layout"
          value={view}
          onChange={setView}
          options={[
            { value: 'grid', label: <LayoutGrid aria-label="Grid" /> },
            { value: 'list', label: <List aria-label="List" /> },
          ]}
        />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <ErrorNote error={error} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Database />}
            title={q ? `No buckets match “${q}”` : 'No buckets yet'}
            description={q ? 'Try a different search.' : 'Create your first bucket to start storing replicated, verified objects.'}
            action={!q && <Button variant="primary" onClick={() => setCreating(true)}><Plus /> Create bucket</Button>}
          />
        </Card>
      ) : view === 'grid' ? (
        <div className={cx('grid grid-cols-1 gap-4 transition-opacity duration-200 sm:grid-cols-2 lg:grid-cols-3', isFetching && 'opacity-80')}>
          {items.map((b) => (
            <Link key={b.id} to={`/buckets/${encodeURIComponent(b.name)}`} className="pressable press-subtle group block rounded-xl">
              <Card className="hover-raise h-full p-5">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-fg-2 shadow-[inset_0_0_0_1px_var(--border)]">
                    <Database className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={b.name}>{b.name}</p>
                    <p className="truncate text-xs text-fg-2">{b.permission === 'OWNER' ? 'Owned by you' : `Shared by ${b.ownerEmail}`}</p>
                  </div>
                </div>
                <div className="mt-5 flex items-end justify-between gap-3">
                  <div>
                    <p className="text-xl font-semibold tracking-tight">{formatBytes(b.totalBytes)}</p>
                    <p className="text-xs text-fg-2">{plural(b.objectCount ?? 0, 'object', 'objects')}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {b.versioningEnabled && <Badge tone="info"><History className="size-3" /> Versioned</Badge>}
                    {b.publicRead ? <Badge tone="warn"><Globe className="size-3" /> Public</Badge> : <Badge><Lock className="size-3" /> Private</Badge>}
                  </div>
                </div>
                <p className="mt-4 border-t border-line pt-3 text-xs text-fg-3">
                  Created <RelativeTime iso={b.createdAt} />
                </p>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead className="border-b border-line">
                <tr>
                  <Th>Name</Th>
                  <Th align="right">Objects</Th>
                  <Th align="right">Size</Th>
                  <Th>Access</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((b) => (
                  <tr key={b.id} className="transition-colors duration-150 hover:bg-surface-2/60">
                    <Td>
                      <Link to={`/buckets/${encodeURIComponent(b.name)}`} className="flex items-center gap-2 font-medium hover:underline">
                        <Database className="size-4 text-fg-3" /> {b.name}
                      </Link>
                    </Td>
                    <Td align="right" className="tabular-nums">{(b.objectCount ?? 0).toLocaleString()}</Td>
                    <Td align="right" className="tabular-nums">{formatBytes(b.totalBytes)}</Td>
                    <Td>
                      <span className="flex gap-1.5">
                        {b.publicRead ? <Badge tone="warn">Public</Badge> : <Badge>Private</Badge>}
                        {b.versioningEnabled && <Badge tone="info">Versioned</Badge>}
                      </span>
                    </Td>
                    <Td className="text-fg-2"><RelativeTime iso={b.createdAt} /></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <CreateBucket open={creating} onOpenChange={setCreating} />
    </>
  );
}
