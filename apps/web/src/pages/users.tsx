import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, ShieldCheck, UserCheck, UserX, Users } from 'lucide-react';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { ConfirmDialog, DropdownMenu, MenuItem } from '../components/ui/overlays';
import { Avatar, Badge, Card, EmptyState, ErrorNote, Input, PageHeader, RelativeTime, Skeleton, Td, Th } from '../components/ui/primitives';
import { http, type AdminUser } from '../lib/api';
import { formatBytes, plural } from '../lib/format';
import { useMe } from '../lib/queries';

export function UsersPage() {
  const me = useMe().data;
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<{ user: AdminUser; change: { role?: 'ADMIN' | 'MEMBER'; status?: 'ACTIVE' | 'DISABLED' } } | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => http.get<{ items: AdminUser[] }>('/api/users'), enabled: me?.role === 'ADMIN' });
  const update = useMutation({
    mutationFn: ({ id, change }: { id: string; change: object }) => http.patch(`/api/users/${id}`, change),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('User updated');
      setPending(null);
    },
  });
  if (me && me.role !== 'ADMIN') return <Navigate to="/" replace />;
  const list = (users.data?.items ?? []).filter((u) => !q || u.email.toLowerCase().includes(q.toLowerCase()) || (u.name ?? '').toLowerCase().includes(q.toLowerCase()));
  const describe = (p: NonNullable<typeof pending>) =>
    p.change.status === 'DISABLED'
      ? `${p.user.email} will be signed out everywhere and can no longer sign in or use API keys.`
      : p.change.status === 'ACTIVE'
        ? `${p.user.email} will be able to sign in again.`
        : p.change.role === 'ADMIN'
          ? `${p.user.email} will get full access to every bucket and administration.`
          : `${p.user.email} will lose administrator access.`;

  return (
    <>
      <PageHeader title="Users" description={users.data ? `${plural(users.data.items.length, 'account', 'accounts')} in this cluster.` : 'Manage accounts and roles.'} />
      <Input aria-label="Search users" placeholder="Search by name or email…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4 max-w-sm" />
      <Card className="overflow-hidden">
        {users.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : users.error ? (
          <div className="p-4"><ErrorNote error={users.error} /></div>
        ) : !list.length ? (
          <EmptyState icon={<Users />} title="No users match" />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead className="border-b border-line">
                <tr><Th>User</Th><Th>Role</Th><Th>Status</Th><Th align="right">Buckets</Th><Th align="right">Storage</Th><Th>Last sign-in</Th><Th align="right"><span className="sr-only">Actions</span></Th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((u) => {
                  const self = u.id === me?.id;
                  return (
                    <tr key={u.id}>
                      <Td>
                        <span className="flex min-w-0 items-center gap-3">
                          <Avatar name={u.name} email={u.email} size={30} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{u.name ?? u.email.split('@')[0]}{self && <span className="ml-1.5 text-xs font-normal text-fg-3">(you)</span>}</span>
                            <span className="block truncate text-xs text-fg-2">{u.email}</span>
                          </span>
                        </span>
                      </Td>
                      <Td>{u.role === 'ADMIN' ? <Badge tone="info"><ShieldCheck className="size-3" /> Admin</Badge> : <Badge>Member</Badge>}</Td>
                      <Td>{u.status === 'ACTIVE' ? <Badge tone="good" icon>Active</Badge> : <Badge tone="bad" icon>Disabled</Badge>}</Td>
                      <Td align="right" className="tabular-nums">{u.buckets.toLocaleString()}</Td>
                      <Td align="right" className="tabular-nums">{formatBytes(u.bytes)}</Td>
                      <Td className="text-fg-2"><RelativeTime iso={u.lastLoginAt} /></Td>
                      <Td align="right">
                        {!self && (
                          <DropdownMenu trigger={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.email}`}><MoreHorizontal /></Button>}>
                            {u.role === 'MEMBER' ? (
                              <MenuItem onClick={() => setPending({ user: u, change: { role: 'ADMIN' } })}><ShieldCheck /> Make administrator</MenuItem>
                            ) : (
                              <MenuItem onClick={() => setPending({ user: u, change: { role: 'MEMBER' } })}><ShieldCheck /> Remove administrator</MenuItem>
                            )}
                            {u.status === 'ACTIVE' ? (
                              <MenuItem danger onClick={() => setPending({ user: u, change: { status: 'DISABLED' } })}><UserX /> Disable account</MenuItem>
                            ) : (
                              <MenuItem onClick={() => setPending({ user: u, change: { status: 'ACTIVE' } })}><UserCheck /> Enable account</MenuItem>
                            )}
                          </DropdownMenu>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => { if (!o) { setPending(null); update.reset(); } }}
        title={pending?.change.status === 'DISABLED' ? 'Disable account?' : pending?.change.status === 'ACTIVE' ? 'Enable account?' : 'Change role?'}
        description={pending ? describe(pending) : ''}
        confirmLabel={pending?.change.status === 'DISABLED' ? 'Disable' : 'Confirm'}
        tone={pending?.change.status === 'DISABLED' ? 'danger' : 'primary'}
        onConfirm={() => pending && update.mutate({ id: pending.user.id, change: pending.change })}
        busy={update.isPending}
        error={update.error ? <ErrorNote error={update.error} /> : null}
      />
    </>
  );
}
