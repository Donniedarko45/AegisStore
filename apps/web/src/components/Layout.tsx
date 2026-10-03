import { useQueryClient } from '@tanstack/react-query';
import { Activity, Database, HardDrive, KeyRound, LayoutDashboard, LogOut, ScrollText, ShieldCheck } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { http } from '../api';
import { useMe } from '../hooks';
import { cx } from '../lib/format';
import { Badge } from './ui';

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/buckets', label: 'Buckets', icon: Database },
  { to: '/nodes', label: 'Storage Nodes', icon: HardDrive },
  { to: '/audit', label: 'Audit Logs', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: KeyRound },
];

export function Layout() {
  const me = useMe().data;
  const qc = useQueryClient();
  const navigate = useNavigate();

  const logout = async () => {
    await http.post('/api/auth/logout').catch(() => undefined);
    qc.clear();
    navigate('/login');
  };

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-border bg-surface md:sticky md:top-0 md:h-screen md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <div className="grid size-8 place-items-center rounded-lg bg-brand text-white">
            <ShieldCheck className="size-5" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold tracking-tight">AegisStore</div>
            <div className="text-[11px] text-muted">Distributed object storage</div>
          </div>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:overflow-visible md:pb-0">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors', isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-text')
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden border-t border-border p-3 md:block">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <div className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-semibold text-brand">{(me?.email ?? '?').charAt(0).toUpperCase()}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{me?.name ?? me?.email}</div>
              <div className="mt-0.5">{me?.role === 'ADMIN' ? <Badge tone="brand">Admin</Badge> : <Badge>Member</Badge>}</div>
            </div>
            <button onClick={logout} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" aria-label="Sign out" title="Sign out">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-8">
          <div className="mb-4 flex items-center justify-end gap-2 md:hidden">
            <span className="mr-auto flex items-center gap-1.5 text-xs text-muted">
              <Activity className="size-3.5" /> {me?.email}
            </span>
            <button onClick={logout} className="flex items-center gap-1.5 text-xs text-muted hover:text-text">
              <LogOut className="size-3.5" /> Sign out
            </button>
          </div>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
