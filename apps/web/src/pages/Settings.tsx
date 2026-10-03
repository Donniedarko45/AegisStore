import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { http, type ApiKeyDto } from '../api';
import { Badge, Button, Card, CardHeader, ConfirmDialog, CopyButton, EmptyState, ErrorNote, Field, Input, Loading, Modal, Mono, PageHeader, Td, Th, Toggle, useToast } from '../components/ui';
import { useMe } from '../hooks';
import { formatDate, timeAgo } from '../lib/format';

function CreateKeyModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [write, setWrite] = useState(true);
  const [admin, setAdmin] = useState(false);
  const [created, setCreated] = useState<(ApiKeyDto & { key: string }) | null>(null);
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => http.post<ApiKeyDto & { key: string }>('/api/api-keys', { name, scopes: ['read', ...(write ? ['write'] : []), ...(admin ? ['admin'] : [])] }),
    onSuccess: (k) => {
      setCreated(k);
      void qc.invalidateQueries({ queryKey: ['apikeys'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  if (created) {
    return (
      <Modal title="API key created" onClose={onClose} width="max-w-lg" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <p className="text-sm text-muted">Copy this key now. For your security it will <strong className="text-text">not be shown again</strong>.</p>
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <Mono className="flex-1">{created.key}</Mono>
          <CopyButton text={created.key} />
        </div>
        <div className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
          <div className="mb-1 font-medium text-text">Use it from scripts</div>
          <Mono>curl -H "Authorization: Bearer {created.key.slice(0, 18)}…" {window.location.origin}/api/buckets</Mono>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Create API key"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-key" loading={create.isPending} disabled={!name.trim()}>Create key</Button>
        </>
      }
    >
      <form id="create-key" onSubmit={submit} className="space-y-4">
        <Field label="Name" hint="Something that tells you where the key is used">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="CI uploader" />}</Field>
        <Toggle checked label="Read" description="List and download objects" onChange={() => undefined} disabled />
        <Toggle checked={write} onChange={setWrite} label="Write" description="Upload and delete objects" />
        <Toggle checked={admin} onChange={setAdmin} label="Admin" description="Manage bucket settings and permissions" />
        <ErrorNote error={create.error} />
      </form>
    </Modal>
  );
}

export function SettingsPage() {
  const me = useMe().data;
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const keys = useQuery({ queryKey: ['apikeys'], queryFn: () => http.get<{ items: ApiKeyDto[] }>('/api/api-keys') });
  const revoke = useMutation({
    mutationFn: (k: ApiKeyDto) => http.del(`/api/api-keys/${k.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['apikeys'] });
      toast('ok', 'API key revoked');
      setRevoking(null);
    },
  });
  const active = (keys.data?.items ?? []).filter((k) => !k.revokedAt);

  return (
    <>
      <PageHeader title="Settings" description="Your account and API access." />

      <Card className="mb-4">
        <CardHeader title="Account" />
        <dl className="grid gap-4 p-5 text-sm sm:grid-cols-3">
          <div><dt className="text-muted">Email</dt><dd className="mt-0.5 font-medium">{me?.email}</dd></div>
          <div><dt className="text-muted">Role</dt><dd className="mt-0.5">{me?.role === 'ADMIN' ? <Badge tone="brand">Administrator</Badge> : <Badge>Member</Badge>}</dd></div>
          <div><dt className="text-muted">Member since</dt><dd className="mt-0.5 font-medium">{formatDate(me?.createdAt)}</dd></div>
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="API keys"
          subtitle="Authenticate scripts with  Authorization: Bearer <key>"
          action={<Button variant="primary" size="sm" onClick={() => setCreating(true)}><Plus className="size-4" /> Create key</Button>}
        />
        {keys.isLoading ? (
          <Loading />
        ) : active.length === 0 ? (
          <EmptyState icon={<KeyRound className="size-5" />} title="No API keys" description="Create a key to upload and download from scripts and CI." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border bg-surface-2/50">
                <tr><Th>Name</Th><Th>Key</Th><Th>Scopes</Th><Th>Last used</Th><Th>Created</Th><Th align="right" /></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {active.map((k) => (
                  <tr key={k.id}>
                    <Td className="font-medium">{k.name}</Td>
                    <Td><Mono>{k.prefix}_••••</Mono></Td>
                    <Td><span className="flex gap-1">{k.scopes.map((s) => <Badge key={s} tone={s === 'admin' ? 'warn' : 'neutral'}>{s}</Badge>)}</span></Td>
                    <Td className="text-muted">{timeAgo(k.lastUsedAt)}</Td>
                    <Td className="text-muted">{formatDate(k.createdAt)}</Td>
                    <Td align="right"><Button variant="ghost" size="sm" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}><Trash2 className="size-4" /></Button></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && <CreateKeyModal onClose={() => setCreating(false)} />}
      {revoking && (
        <ConfirmDialog title="Revoke API key" confirmLabel="Revoke" message={<>Revoke <strong className="text-text">{revoking.name}</strong>? Anything using it will immediately lose access.</>} busy={revoke.isPending} error={revoke.error} onConfirm={() => revoke.mutate(revoking)} onClose={() => { setRevoking(null); revoke.reset(); }} />
      )}
    </>
  );
}
