import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Laptop, Monitor, Moon, Plus, Server, ShieldCheck, Smartphone, Sun, Trash2, User } from 'lucide-react';
import { useTheme } from '../lib/theme';
import { useState, type FormEvent } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { ConfirmDialog, Modal, SelectBox, SwitchField } from '../components/ui/overlays';
import { Avatar, Badge, Card, CardHeader, CopyButton, EmptyState, ErrorNote, Field, Input, Mono, PageHeader, RelativeTime, Skeleton, StatusDot, Td, Th } from '../components/ui/primitives';
import { http, type ApiKeyDto, type SessionDto } from '../lib/api';
import { cx, formatBytes, formatDateTime, formatDuration } from '../lib/format';
import { useMe, useSystem } from '../lib/queries';

const SECTIONS = [
  { id: 'general', label: 'General', icon: User },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'api-keys', label: 'API keys', icon: KeyRound },
  { id: 'appearance', label: 'Appearance', icon: Sun },
  { id: 'system', label: 'System', icon: Server },
] as const;

function describeAgent(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Unknown device', mobile: false };
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici/i.test(ua) ? 'Script' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return { label: os ? `${browser} on ${os}` : browser, mobile: /Android|iPhone|iPad|Mobile/.test(ua) };
}

function General() {
  const me = useMe().data;
  if (!me) return null;
  return (
    <Card>
      <CardHeader title="Profile" description="Your account details." />
      <div className="flex items-center gap-4 border-t border-line px-5 py-5">
        <Avatar name={me.name} email={me.email} size={52} />
        <div className="min-w-0">
          <p className="truncate text-base font-medium">{me.name ?? me.email.split('@')[0]}</p>
          <p className="truncate text-[13px] text-fg-2">{me.email}</p>
        </div>
        <span className="ml-auto">{me.role === 'ADMIN' ? <Badge tone="info">Administrator</Badge> : <Badge>Member</Badge>}</span>
      </div>
      <dl className="grid grid-cols-1 gap-4 border-t border-line px-5 py-4 text-[13px] sm:grid-cols-2">
        <div><dt className="text-fg-2">Member since</dt><dd className="mt-0.5 font-medium">{formatDateTime(me.createdAt)}</dd></div>
        <div><dt className="text-fg-2">User ID</dt><dd className="mt-0.5 flex items-center gap-1"><Mono className="truncate">{me.id}</Mono><CopyButton text={me.id} label="Copy user ID" /></dd></div>
      </dl>
    </Card>
  );
}

function Security() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && confirm !== next;
  const change = useMutation({
    mutationFn: () => http.post<{ revokedSessions: number }>('/api/auth/password', { currentPassword: current, newPassword: next }),
    onSuccess: (r) => {
      setCurrent('');
      setNext('');
      setConfirm('');
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      toast.success('Password changed', { description: r.revokedSessions ? `Signed out ${r.revokedSessions} other session${r.revokedSessions === 1 ? '' : 's'}.` : undefined });
    },
  });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => http.get<{ items: SessionDto[] }>('/api/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => http.del(`/api/auth/sessions/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      toast.success('Session signed out');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch && next.length >= 8) change.mutate();
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Password" description="Changing it signs you out on every other device." />
        <form onSubmit={submit} className="grid grid-cols-1 gap-4 border-t border-line px-5 py-5 sm:max-w-md">
          <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
          <Field label="New password" hint="At least 8 characters.">{(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
          <Field label="Confirm new password" error={mismatch ? 'Passwords do not match.' : null}>{(id) => <Input id={id} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
          <ErrorNote error={change.error} />
          <div><Button type="submit" variant="primary" loading={change.isPending} disabled={mismatch || next.length < 8 || !current}>Update password</Button></div>
        </form>
      </Card>
      <Card>
        <CardHeader title="Sessions" description="Devices currently signed in to your account." />
        {sessions.isLoading ? (
          <div className="p-5"><Skeleton className="h-16" /></div>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {(sessions.data?.items ?? []).map((s) => {
              const d = describeAgent(s.userAgent);
              const Icon = d.mobile ? Smartphone : Laptop;
              return (
                <li key={s.id} className="flex items-center gap-3 px-5 py-3.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-fg-2"><Icon className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">{d.label}{s.current && <Badge tone="good">This device</Badge>}</p>
                    <p className="truncate text-xs text-fg-2">{s.ip ?? 'unknown IP'} · active <RelativeTime iso={s.lastUsedAt} /> · signed in {formatDateTime(s.createdAt)}</p>
                  </div>
                  {!s.current && <Button size="sm" variant="danger-ghost" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>Sign out</Button>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(true);
  const [admin, setAdmin] = useState(false);
  const [expiry, setExpiry] = useState<'never' | '30' | '90' | '365'>('90');
  const [created, setCreated] = useState<(ApiKeyDto & { key: string }) | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);
  const keys = useQuery({ queryKey: ['apikeys'], queryFn: () => http.get<{ items: ApiKeyDto[] }>('/api/api-keys') });
  const create = useMutation({
    mutationFn: () => http.post<ApiKeyDto & { key: string }>('/api/api-keys', { name: name.trim(), scopes: ['read', ...(write ? ['write'] : []), ...(admin ? ['admin'] : [])], ...(expiry !== 'never' && { expiresInDays: Number(expiry) }) }),
    onSuccess: (k) => {
      setCreated(k);
      void qc.invalidateQueries({ queryKey: ['apikeys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (k: ApiKeyDto) => http.del(`/api/api-keys/${k.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['apikeys'] });
      setRevoking(null);
      toast.success('API key revoked');
    },
  });
  const active = (keys.data?.items ?? []).filter((k) => !k.revokedAt);
  const reset = () => {
    setCreating(false);
    setCreated(null);
    setName('');
    setWrite(true);
    setAdmin(false);
    setExpiry('90');
    create.reset();
  };
  return (
    <Card>
      <CardHeader title="API keys" description={<>Authenticate scripts and CI with <Mono>Authorization: Bearer &lt;key&gt;</Mono>.</>} action={<Button variant="primary" size="sm" onClick={() => setCreating(true)}><Plus /> Create key</Button>} />
      {keys.isLoading ? (
        <div className="p-5"><Skeleton className="h-16" /></div>
      ) : !active.length ? (
        <EmptyState icon={<KeyRound />} title="No API keys" description="Create a key to upload and download from scripts." className="border-t border-line" />
      ) : (
        <div className="relative overflow-x-auto border-t border-line">
          <table className="w-full min-w-[640px]">
            <thead className="border-b border-line"><tr><Th>Name</Th><Th>Key</Th><Th>Scopes</Th><Th>Last used</Th><Th>Expires</Th><Th align="right"><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody className="divide-y divide-line">
              {active.map((k) => (
                <tr key={k.id}>
                  <Td className="font-medium">{k.name}</Td>
                  <Td><Mono className="text-fg-2">{k.prefix}_••••••</Mono></Td>
                  <Td><span className="flex gap-1">{k.scopes.map((s) => <Badge key={s} tone={s === 'admin' ? 'warn' : 'neutral'}>{s}</Badge>)}</span></Td>
                  <Td className="text-fg-2"><RelativeTime iso={k.lastUsedAt} /></Td>
                  <Td className="text-fg-2">{k.expiresAt ? <RelativeTime iso={k.expiresAt} /> : 'Never'}</Td>
                  <Td align="right"><Button size="icon-sm" variant="ghost" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}><Trash2 /></Button></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={creating}
        onOpenChange={(o) => !o && reset()}
        title={created ? 'Save your API key' : 'Create API key'}
        description={created ? 'This is the only time the full key is shown. Store it somewhere safe.' : 'Keys act as you, limited to the scopes you choose.'}
        width="max-w-[520px]"
        footer={
          created ? (
            <Button variant="primary" onClick={reset}>Done</Button>
          ) : (
            <>
              <Button onClick={reset}>Cancel</Button>
              <Button variant="primary" type="submit" form="create-key" disabled={!name.trim()} loading={create.isPending}>Create key</Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-3">
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 py-2 pr-1.5 pl-3 shadow-[inset_0_0_0_1px_var(--border)]">
              <Mono className="flex-1 text-[13px]">{created.key}</Mono>
              <CopyButton text={created.key} label="Copy key" />
            </div>
            <div className="rounded-lg bg-surface-2 p-3 text-xs text-fg-2">
              <p className="mb-1.5 font-medium text-fg">Try it</p>
              <Mono className="block">curl -H "Authorization: Bearer {created.key.slice(0, 20)}…" {location.origin}/api/buckets</Mono>
            </div>
          </div>
        ) : (
          <form id="create-key" className="space-y-5" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
            <Field label="Name" hint="Where this key is used, e.g. “CI uploader”.">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}</Field>
            <SwitchField checked label="Read" description="List buckets and download objects (always on)." onChange={() => undefined} disabled />
            <SwitchField checked={write} onChange={setWrite} label="Write" description="Upload and delete objects." />
            <SwitchField checked={admin} onChange={setAdmin} label="Manage" description="Change bucket settings and permissions." />
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium">Expires</span>
              <SelectBox label="Expiry" value={expiry} onChange={setExpiry} className="w-40" options={[{ value: '30', label: 'In 30 days' }, { value: '90', label: 'In 90 days' }, { value: '365', label: 'In 1 year' }, { value: 'never', label: 'Never' }]} />
            </div>
            <ErrorNote error={create.error} />
          </form>
        )}
      </Modal>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke API key?"
        description={<>Anything using <span className="font-medium text-fg">{revoking?.name}</span> stops working immediately.</>}
        confirmLabel="Revoke key"
        onConfirm={() => revoking && revoke.mutate(revoking)}
        busy={revoke.isPending}
      />
    </Card>
  );
}

function ThemePreview({ dark }: { dark: boolean }) {
  return (
    <div className={cx('h-20 overflow-hidden rounded-md p-2', dark ? 'bg-[#0a0a0a]' : 'bg-[#fafafa]')} aria-hidden>
      <div className={cx('h-2 w-10 rounded-full', dark ? 'bg-[#333]' : 'bg-[#ddd]')} />
      <div className={cx('mt-2 rounded p-1.5', dark ? 'bg-[#161616]' : 'bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)]')}>
        <div className="flex h-6 items-end gap-0.5">{[40, 70, 55, 90, 65].map((h, i) => <span key={i} className="w-2 rounded-t-[2px] bg-[#2a78d6]" style={{ height: `${h}%` }} />)}</div>
      </div>
    </div>
  );
}

function Appearance() {
  const { theme = 'system', setTheme } = useTheme();
  const options = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ] as const;
  return (
    <Card>
      <CardHeader title="Theme" description="Choose how AegisStore looks on this device." />
      <div className="grid grid-cols-1 gap-3 border-t border-line p-5 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
        {options.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={theme === o.id}
            onClick={() => setTheme(o.id)}
            className={cx('pressable rounded-lg p-2 text-left shadow-[0_0_0_1px_var(--border-2)] transition-shadow duration-150', theme === o.id && 'shadow-[0_0_0_2px_var(--fg)]')}
          >
            {o.id === 'system' ? (
              <div className="grid grid-cols-2 overflow-hidden rounded-md"><ThemePreview dark={false} /><ThemePreview dark /></div>
            ) : (
              <ThemePreview dark={o.id === 'dark'} />
            )}
            <span className="mt-2 flex items-center gap-1.5 px-1 text-sm font-medium"><o.icon className="size-3.5 text-fg-2" /> {o.label}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function System() {
  const sys = useSystem();
  const s = sys.data;
  if (sys.isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (!s) return <ErrorNote error={sys.error} />;
  const comp = [
    { label: 'API', ok: s.components.api === 'up', detail: `v${s.version} · up ${formatDuration((Date.now() - Date.parse(s.startedAt)) / 1000)}` },
    { label: 'PostgreSQL', ok: s.components.database === 'up', detail: s.components.postgresVersion ? `v${s.components.postgresVersion}` : '' },
    { label: 'Redis', ok: s.components.redis === 'up', detail: s.components.redis === 'up' ? 'live events and rate limits' : 'degraded: no live events, rate limits fail open' },
  ];
  const cfg = [
    ['Replication factor', `${s.config.replicationFactor} copies on distinct nodes`],
    ['Virtual nodes per node', s.config.vnodesPerNode.toLocaleString()],
    ['Offline after', `${s.config.offlineAfterMs / 1000}s without a heartbeat`],
    ['Probation', `${s.config.probationBeats} heartbeats before a node is trusted again`],
    ['Single upload limit', formatBytes(s.config.maxUploadBytes)],
    ['Verify-before-send', `downloads up to ${formatBytes(s.config.verifyBufferMaxBytes)}`],
    ['Retention', s.config.retentionHours === 0 ? 'immediate purge' : `${s.config.retentionHours}h before deleted data is purged`],
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Components" />
        <ul className="divide-y divide-line border-t border-line">
          {comp.map((c) => (
            <li key={c.label} className="flex items-center gap-3 px-5 py-3 text-sm">
              <StatusDot tone={c.ok ? 'good' : 'warn'} />
              <span className="font-medium">{c.label}</span>
              <span className="text-fg-2">{c.ok ? 'Operational' : 'Degraded'}</span>
              <span className="ml-auto truncate text-xs text-fg-3">{c.detail}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Cluster configuration" description="Set through environment variables (see .env.example)." />
        <dl className="divide-y divide-line border-t border-line">
          {cfg.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[200px_1fr] gap-4 px-5 py-3 text-[13px]"><dt className="text-fg-2">{k}</dt><dd className="font-medium">{v}</dd></div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const { section = 'general' } = useParams();
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
        <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map((s) => (
            <NavLink
              key={s.id}
              to={s.id === 'general' ? '/settings' : `/settings/${s.id}`}
              end
              className={() => cx('pressable flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm transition-colors duration-150', current.id === s.id ? 'bg-surface-2 font-medium text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg')}
            >
              <s.icon className="size-4" /> {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">
          {current.id === 'general' && <General />}
          {current.id === 'security' && <Security />}
          {current.id === 'api-keys' && <ApiKeys />}
          {current.id === 'appearance' && <Appearance />}
          {current.id === 'system' && <System />}
        </div>
      </div>
    </>
  );
}
