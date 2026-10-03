import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Monitor, Moon, Search, Settings, ShieldCheck, Sun } from 'lucide-react';
import { useTheme } from '../../lib/theme';
import { Component, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Spinner } from '../ui/spinner';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { http } from '../../lib/api';
import { useLive } from '../../lib/live';
import { cx, plural } from '../../lib/format';
import { useMe, useNodes } from '../../lib/queries';
import { Button } from '../ui/button';
import { DropdownMenu, MenuItem, MenuLabel, MenuRadio, MenuSeparator, Tip } from '../ui/overlays';
import { Avatar, Badge, Kbd, StatusDot } from '../ui/primitives';
import { CommandMenu, useCommandMenu } from './command-menu';
import { UploadPanel } from './uploads';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/buckets', label: 'Buckets' },
  { to: '/nodes', label: 'Nodes' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/activity', label: 'Activity' },
  { to: '/users', label: 'Users', admin: true },
  { to: '/settings', label: 'Settings' },
];

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx('grid size-7 place-items-center rounded-lg bg-accent text-accent-fg', className)}>
      <ShieldCheck className="size-4" strokeWidth={2.25} />
    </span>
  );
}

/**
 * Vercel-style tab nav. Hover: a pill that follows the pointer (fast, 150ms; it is seen tens of
 * times a day, so it stays subtle). Active: an underline that slides on route change.
 * Both move with transform; the pill jumps without transition when it first appears.
 */
function NavTabs({ isAdmin }: { isAdmin: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  const [hover, setHover] = useState<{ left: number; width: number; visible: boolean; animate: boolean }>({ left: 0, width: 0, visible: false, animate: false });
  const [active, setActive] = useState<{ left: number; width: number } | null>(null);
  const items = NAV.filter((n) => !n.admin || isAdmin);

  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
    setActive(el ? { left: el.offsetLeft + 8, width: el.offsetWidth - 16 } : null);
  }, [loc.pathname, isAdmin]);

  return (
    <div ref={ref} className="relative flex items-center overflow-x-auto [scrollbar-width:none]" onPointerLeave={() => setHover((h) => ({ ...h, visible: false, animate: false }))}>
      <span
        aria-hidden
        className="absolute top-1/2 h-8 -translate-y-1/2 rounded-md bg-surface-2"
        style={{
          width: hover.width,
          transform: `translate(${hover.left}px, -50%)`,
          opacity: hover.visible ? 1 : 0,
          transition: hover.animate ? 'transform 150ms var(--ease-out), width 150ms var(--ease-out), opacity 150ms ease' : 'opacity 150ms ease',
        }}
      />
      {items.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onPointerEnter={(e) => {
            const t = e.currentTarget;
            setHover((h) => ({ left: t.offsetLeft, width: t.offsetWidth, visible: true, animate: h.visible }));
          }}
          className={({ isActive }) => cx('relative z-[1] flex h-11 shrink-0 items-center px-3 text-[13.5px] transition-colors duration-150 ease-[ease]', isActive ? 'text-fg' : 'text-fg-2 hover:text-fg')}
        >
          {n.label}
        </NavLink>
      ))}
      {active && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 rounded-full bg-fg transition-[transform,width] duration-200 ease-in-out"
          style={{ width: active.width, transform: `translateX(${active.left}px)` }}
        />
      )}
    </div>
  );
}

function ClusterStatus() {
  const live = useLive((s) => s.status);
  const nodes = useNodes().data?.items ?? [];
  const down = nodes.filter((n) => n.status !== 'HEALTHY').length;
  const tone = !nodes.length ? 'neutral' : down === 0 ? 'good' : down === nodes.length ? 'bad' : 'warn';
  const label = !nodes.length ? 'No nodes' : down === 0 ? 'All systems normal' : `${plural(down, 'node', 'nodes')} need attention`;
  const liveText = live === 'live' ? 'Live updates connected' : live === 'connecting' ? 'Connecting to live updates…' : 'Live updates offline: polling';
  return (
    <Tip content={liveText}>
      <Link to="/nodes" className="pressable hidden h-8 items-center gap-2 rounded-full px-3 text-[13px] text-fg-2 shadow-[0_0_0_1px_var(--border)] hover:bg-surface-2 hover:text-fg md:flex">
        <StatusDot tone={tone} pulse={live === 'live' && tone === 'good'} />
        {label}
      </Link>
    </Tip>
  );
}

function UserMenu() {
  const me = useMe().data;
  const { theme = 'system', setTheme } = useTheme();
  const qc = useQueryClient();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <DropdownMenu
      width="w-64"
      trigger={
        <button className="pressable rounded-full outline-none" aria-label="Account menu">
          <Avatar name={me.name} email={me.email} size={30} />
        </button>
      }
    >
      <div className="px-2 pt-1.5 pb-2">
        <p className="truncate text-sm font-medium">{me.name ?? me.email.split('@')[0]}</p>
        <p className="truncate text-xs text-fg-2">{me.email}</p>
        <div className="mt-1.5">{me.role === 'ADMIN' ? <Badge tone="info">Administrator</Badge> : <Badge>Member</Badge>}</div>
      </div>
      <MenuSeparator />
      <MenuItem onClick={() => navigate('/settings')}>
        <Settings /> Settings
      </MenuItem>
      <MenuItem onClick={() => navigate('/settings/api-keys')}>
        <KeyRound /> API keys
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Theme</MenuLabel>
      <MenuRadio
        value={theme as 'light' | 'dark' | 'system'}
        onChange={setTheme}
        options={[
          { value: 'light', label: 'Light', icon: <Sun /> },
          { value: 'dark', label: 'Dark', icon: <Moon /> },
          { value: 'system', label: 'System', icon: <Monitor /> },
        ]}
      />
      <MenuSeparator />
      <MenuItem
        onClick={async () => {
          await http.post('/api/auth/logout').catch(() => undefined);
          qc.clear();
          navigate('/login');
        }}
      >
        <LogOut /> Sign out
      </MenuItem>
    </DropdownMenu>
  );
}

export function AppShell() {
  const me = useMe().data;
  const setOpen = useCommandMenu((s) => s.setOpen);
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/85 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-3 px-4 md:px-6">
          <Link to="/" className="flex items-center gap-2.5" aria-label="AegisStore home">
            <Logo />
            <span className="hidden font-semibold tracking-tight sm:inline">AegisStore</span>
          </Link>
          <span className="text-fg-3 select-none" aria-hidden>
            /
          </span>
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <Avatar name={me?.name} email={me?.email} size={20} />
            <span className="truncate font-medium">{me?.name ?? me?.email?.split('@')[0]}</span>
            {me?.role === 'ADMIN' && <Badge tone="info" className="hidden sm:inline-flex">Admin</Badge>}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setOpen(true)}
              className="pressable hidden h-8 w-56 items-center gap-2 rounded-md bg-surface px-2.5 text-[13px] text-fg-3 shadow-[0_0_0_1px_var(--border-2)] hover:text-fg-2 lg:flex"
            >
              <Search className="size-3.5" /> Search…
              <span className="ml-auto flex gap-0.5">
                <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Search">
              <Search />
            </Button>
            <ClusterStatus />
            <UserMenu />
          </div>
        </div>
        <nav aria-label="Main" className="mx-auto max-w-[1240px] px-2 md:px-4">
          <NavTabs isAdmin={me?.role === 'ADMIN'} />
        </nav>
      </header>
      <main className="mx-auto w-full max-w-[1240px] px-4 pt-8 pb-24 md:px-6">
        <ErrorBoundary>
          {/* the shell stays put while a page chunk loads */}
          <Suspense fallback={<div className="grid min-h-[40vh] place-items-center text-fg-3"><Spinner className="size-5" /></div>}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <CommandMenu />
      <UploadPanel />
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <p className="text-lg font-semibold">Something went wrong</p>
        <p className="mt-2 text-sm text-fg-2">This view crashed while rendering. Your data is safe.</p>
        <pre className="mt-4 max-h-40 overflow-auto rounded-lg bg-surface-2 p-3 text-left font-mono text-xs text-fg-2">{this.state.error.message}</pre>
        <Button className="mt-5" onClick={() => location.reload()}>
          Reload page
        </Button>
      </div>
    );
  }
}
