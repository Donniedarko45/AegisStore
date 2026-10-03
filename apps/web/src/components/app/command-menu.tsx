import { Dialog } from '@base-ui/react/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Activity, BarChart3, Database, FlaskConical, HardDrive, KeyRound, LayoutDashboard, LogOut, Monitor, Moon, Plus, Search, Settings, ShieldAlert, Sun, Users } from 'lucide-react';
import { useTheme } from '../../lib/theme';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { http, type BucketDto, type NodeDto } from '../../lib/api';
import { useMe } from '../../lib/queries';
import { Kbd } from '../ui/primitives';

export const useCommandMenu = create<{ open: boolean; setOpen: (o: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

const item = 'flex h-10 cursor-default items-center gap-3 rounded-md px-3 text-sm text-fg data-[selected=true]:bg-surface-2 [&_svg]:size-4 [&_svg]:text-fg-2';

/**
 * ⌘K palette. Opened by keyboard many times a day, so it has NO open/close animation (Emil:
 * never animate keyboard-initiated actions; Raycast has none either).
 */
export function CommandMenu() {
  const { open, setOpen } = useCommandMenu();
  const navigate = useNavigate();
  const { setTheme } = useTheme();
  const me = useMe().data;
  const qc = useQueryClient();
  const [search, setSearch] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useCommandMenu.getState().open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const buckets = useQuery({ queryKey: ['buckets', ''], queryFn: () => http.get<{ items: BucketDto[] }>('/api/buckets?q='), enabled: open && !!me });
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => http.get<{ items: NodeDto[] }>('/api/nodes'), enabled: open && !!me });

  const run = (fn: () => void) => {
    setOpen(false);
    setSearch('');
    fn();
  };
  const Item = ({ children, onSelect, value, shortcut }: { children: ReactNode; onSelect: () => void; value: string; shortcut?: string }) => (
    <Command.Item value={value} onSelect={() => run(onSelect)} className={item}>
      {children}
      {shortcut && <span className="ml-auto text-xs text-fg-3">{shortcut}</span>}
    </Command.Item>
  );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[80] bg-black/30 dark:bg-black/60" />
        <Dialog.Popup className="fixed top-[14vh] left-1/2 z-[80] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl bg-surface shadow-popover outline-none">
          <Dialog.Title className="sr-only">Command menu</Dialog.Title>
          <Command label="Command menu" loop>
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search className="size-4 shrink-0 text-fg-3" />
              <Command.Input autoFocus value={search} onValueChange={setSearch} placeholder="Search buckets, nodes, pages and actions…" className="h-12 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3" />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain p-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-3">
              <Command.Empty className="py-10 text-center text-sm text-fg-2">No results for “{search}”.</Command.Empty>
              <Command.Group heading="Navigate">
                <Item value="overview dashboard" onSelect={() => navigate('/')}><LayoutDashboard /> Overview</Item>
                <Item value="buckets" onSelect={() => navigate('/buckets')}><Database /> Buckets</Item>
                <Item value="storage nodes" onSelect={() => navigate('/nodes')}><HardDrive /> Storage nodes</Item>
                <Item value="analytics charts" onSelect={() => navigate('/analytics')}><BarChart3 /> Analytics</Item>
                <Item value="audit log activity events" onSelect={() => navigate('/audit')}><Activity /> Audit log</Item>
                {me?.role === 'ADMIN' && <Item value="security ransomware alerts anomaly" onSelect={() => navigate('/security')}><ShieldAlert /> Security</Item>}
                {me?.role === 'ADMIN' && <Item value="simulation lab chaos faults drill" onSelect={() => navigate('/lab')}><FlaskConical /> Simulation Lab</Item>}
                {me?.role === 'ADMIN' && <Item value="users administration" onSelect={() => navigate('/users')}><Users /> Users</Item>}
                <Item value="settings account" onSelect={() => navigate('/settings')}><Settings /> Settings</Item>
                <Item value="api keys tokens" onSelect={() => navigate('/settings/api-keys')}><KeyRound /> API keys</Item>
              </Command.Group>
              {!!buckets.data?.items.length && (
                <Command.Group heading="Buckets">
                  {buckets.data.items.slice(0, 50).map((b) => (
                    <Item key={b.id} value={`bucket ${b.name}`} onSelect={() => navigate(`/buckets/${encodeURIComponent(b.name)}`)}>
                      <Database /> <span className="truncate">{b.name}</span>
                      <span className="ml-auto text-xs text-fg-3 tabular-nums">{b.objectCount?.toLocaleString()} objects</span>
                    </Item>
                  ))}
                </Command.Group>
              )}
              {!!nodes.data?.items.length && (
                <Command.Group heading="Storage nodes">
                  {nodes.data.items.map((n) => (
                    <Item key={n.id} value={`node ${n.name} ${n.status}`} onSelect={() => navigate(`/nodes?node=${n.id}`)}>
                      <HardDrive /> {n.name}
                      <span className="ml-auto text-xs text-fg-3">{n.status.toLowerCase()}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Actions">
                <Item value="create new bucket" onSelect={() => navigate('/buckets?new=1')}><Plus /> Create bucket</Item>
                <Item value="theme light" onSelect={() => setTheme('light')}><Sun /> Light theme</Item>
                <Item value="theme dark" onSelect={() => setTheme('dark')}><Moon /> Dark theme</Item>
                <Item value="theme system" onSelect={() => setTheme('system')}><Monitor /> System theme</Item>
                <Item
                  value="sign out logout"
                  onSelect={async () => {
                    await http.post('/api/auth/logout').catch(() => undefined);
                    qc.clear();
                    navigate('/login');
                  }}
                >
                  <LogOut /> Sign out
                </Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
