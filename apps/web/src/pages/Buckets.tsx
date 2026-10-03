import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Globe, History, Plus, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { http, type BucketDto } from '../api';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Td, Th, Toggle, useToast } from '../components/ui';
import { formatBytes, formatDate } from '../lib/format';

function CreateBucketModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [versioning, setVersioning] = useState(false);
  const [publicRead, setPublicRead] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: () => http.post<{ bucket: BucketDto }>('/api/buckets', { name, versioningEnabled: versioning, publicRead }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['buckets'] });
      toast('ok', `Bucket "${r.bucket.name}" created`);
      onClose();
      navigate(`/buckets/${r.bucket.name}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Modal
      title="Create bucket"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="create-bucket" type="submit" loading={create.isPending} disabled={name.length < 3}>
            Create bucket
          </Button>
        </>
      }
    >
      <form id="create-bucket" onSubmit={submit} className="space-y-4">
        <Field label="Bucket name" hint="3–63 characters: lowercase letters, numbers and hyphens (e.g. research-data)">
          {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="research-data" />}
        </Field>
        <Toggle checked={versioning} onChange={setVersioning} label="Enable versioning" description="Keep previous versions when objects are overwritten or deleted." />
        <Toggle checked={publicRead} onChange={setPublicRead} label="Public read access" description="Anyone with the link can list and download objects. Writes still need permission." />
        <ErrorNote error={create.error} />
      </form>
    </Modal>
  );
}

export function BucketsPage() {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BucketDto | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ['buckets', q],
    queryFn: () => http.get<{ items: BucketDto[] }>(`/api/buckets?q=${encodeURIComponent(q)}`),
    placeholderData: (prev) => prev,
  });

  const del = useMutation({
    mutationFn: (b: BucketDto) => http.del(`/api/buckets/${b.name}`),
    onSuccess: (_r, b) => {
      void qc.invalidateQueries({ queryKey: ['buckets'] });
      toast('ok', `Bucket "${b.name}" deleted`);
      setDeleting(null);
    },
  });

  const items = data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Buckets"
        description="Containers for your objects. Each object is replicated across multiple storage nodes."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Create bucket
          </Button>
        }
      />

      <Card>
        <div className="border-b border-border p-3">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <Input aria-label="Search buckets" placeholder="Search buckets…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
        </div>

        {isLoading ? (
          <Loading />
        ) : error ? (
          <div className="p-5">
            <ErrorNote error={error} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Database className="size-5" />}
            title={q ? 'No buckets match your search' : 'No buckets yet'}
            description={q ? undefined : 'Create your first bucket to start uploading objects.'}
            action={!q && <Button variant="primary" onClick={() => setCreating(true)}>Create bucket</Button>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border bg-surface-2/50">
                <tr>
                  <Th>Name</Th>
                  <Th>Objects</Th>
                  <Th>Size</Th>
                  <Th>Access</Th>
                  <Th>Owner</Th>
                  <Th>Created</Th>
                  <Th align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((b) => (
                  <tr key={b.id} className="hover:bg-surface-2/40">
                    <Td>
                      <Link to={`/buckets/${b.name}`} className="flex items-center gap-2 font-medium text-brand hover:underline">
                        <Database className="size-4" /> {b.name}
                      </Link>
                      <div className="mt-1 flex gap-1.5">
                        {b.versioningEnabled && (
                          <Badge tone="info">
                            <History className="size-3" /> Versioned
                          </Badge>
                        )}
                        {b.publicRead && (
                          <Badge tone="warn">
                            <Globe className="size-3" /> Public read
                          </Badge>
                        )}
                      </div>
                    </Td>
                    <Td className="tabular-nums">{b.objectCount?.toLocaleString()}</Td>
                    <Td className="tabular-nums">{formatBytes(b.totalBytes)}</Td>
                    <Td>
                      <Badge tone={b.permission === 'OWNER' || b.permission === 'ADMIN' ? 'brand' : 'neutral'}>{b.permission === 'OWNER' ? 'Owner' : (b.permission ?? 'Read')}</Badge>
                    </Td>
                    <Td className="text-muted">{b.ownerEmail}</Td>
                    <Td className="text-muted">{formatDate(b.createdAt)}</Td>
                    <Td align="right">
                      {(b.permission === 'OWNER' || b.permission === 'ADMIN') && (
                        <Button variant="ghost" size="sm" onClick={() => setDeleting(b)} aria-label={`Delete bucket ${b.name}`}>
                          <Trash2 className="size-4" />
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

      {creating && <CreateBucketModal onClose={() => setCreating(false)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete bucket"
          message={
            <>
              Delete <strong className="text-text">{deleting.name}</strong>? Only empty buckets can be deleted.
            </>
          }
          busy={del.isPending}
          error={del.error}
          onConfirm={() => del.mutate(deleting)}
          onClose={() => {
            setDeleting(null);
            del.reset();
          }}
        />
      )}
    </>
  );
}
