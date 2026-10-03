import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { cx } from '../lib/format';

// ------------------------------------------------------------------------------------ Button
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover shadow-sm',
  secondary: 'bg-surface border border-border text-text hover:bg-surface-2',
  danger: 'bg-bad text-white hover:opacity-90 shadow-sm',
  ghost: 'text-muted hover:text-text hover:bg-surface-2',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        variants[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

// -------------------------------------------------------------------------------- form fields
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-bad">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

// width is only defaulted to full when the caller did not pass its own w-* utility
const fieldBase =
  'h-9 rounded-lg border border-border bg-surface px-3 text-sm placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:opacity-60';

const widthClass = (c?: string) => (c && /(^|\s)w-/.test(c) ? '' : 'w-full');
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(fieldBase, widthClass(className), className)} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(fieldBase, widthClass(className), 'pr-8', className)} />;

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start gap-3', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-brand' : 'bg-border')}
      >
        <span className={cx('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
      </button>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
    </label>
  );
}

// --------------------------------------------------------------------------------------- Card
export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cx('rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]', className)}>{children}</div>
);

export function CardHeader({ title, action, subtitle }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {back}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// -------------------------------------------------------------------------------------- Badge
type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'brand';
const tones: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  brand: 'bg-brand-soft text-brand',
  neutral: 'bg-surface-2 text-muted',
};
export const Badge = ({ tone = 'neutral', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) => (
  <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone])}>
    {dot && <span className="size-1.5 rounded-full bg-current" />}
    {children}
  </span>
);

export const nodeTone = (s: string): Tone => ({ HEALTHY: 'ok', WARNING: 'warn', HIGH_RISK: 'bad', OFFLINE: 'bad', DRAINING: 'info' })[s] as Tone ?? 'neutral';
export const integrityTone = (s: string): Tone => ({ HEALTHY: 'ok', DEGRADED: 'warn', UNAVAILABLE: 'bad' })[s] as Tone ?? 'neutral';
export const classTone = (s: string): Tone => ({ HOT: 'bad', WARM: 'warn', COLD: 'info' })[s] as Tone ?? 'neutral';
export const integrityLabel = (s: string) => ({ HEALTHY: 'Healthy', DEGRADED: 'Degraded', UNAVAILABLE: 'Unavailable' })[s] ?? s;

// ------------------------------------------------------------------------------------ Progress
export function Meter({ pct, tone }: { pct: number; tone?: Tone }) {
  const t: Tone = tone ?? (pct > 90 ? 'bad' : pct > 75 ? 'warn' : 'brand');
  const fill = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', brand: 'bg-brand', neutral: 'bg-muted' }[t];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-all', fill)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

// ------------------------------------------------------------------------------ States / misc
export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cx('size-5 animate-spin text-muted', className)} aria-label="Loading" />;

export const Loading = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
    <Spinner /> {label}
  </div>
);

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-surface-2 text-muted">{icon}</div>
      <div>
        <p className="font-medium">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cx('flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad', className)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{msg}</span>
    </div>
  );
}

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => <code className={cx('font-mono text-xs break-all', className)}>{children}</code>;

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-border">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors', value === t.id ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-text')}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 text-xs">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------- Overlays (Modal/Drawer)
function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Modal({ title, onClose, children, footer, width = 'max-w-md' }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEscape(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] [animation:fade-in_.15s]" onClick={onClose} aria-hidden />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={cx('relative w-full rounded-xl border border-border bg-surface shadow-2xl [animation:pop_.18s_ease-out] focus:outline-none', width)}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children, actions }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/40 [animation:fade-in_.15s]" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true" className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-border bg-surface shadow-2xl [animation:slide-in_.2s_ease-out]">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 text-xs text-muted">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-1">
            {actions}
            <button onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-surface-2" aria-label="Close panel">
              <X className="size-4" />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Delete', onConfirm, onClose, busy, error }: { title: string; message: ReactNode; confirmLabel?: string; onConfirm: () => void; onClose: () => void; busy?: boolean; error?: unknown }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted">{message}</div>
      <ErrorNote error={error} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------- Toasts
interface Toast { id: number; tone: 'ok' | 'bad' | 'info'; text: string }
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, tone, text }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4500);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2" aria-live="polite">
        {items.map((t) => {
          const Icon = t.tone === 'ok' ? CheckCircle2 : t.tone === 'bad' ? AlertTriangle : Info;
          return (
            <div key={t.id} className="pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm shadow-lg [animation:pop_.2s_ease-out]">
              <Icon className={cx('mt-0.5 size-4 shrink-0', t.tone === 'ok' ? 'text-ok' : t.tone === 'bad' ? 'text-bad' : 'text-info')} />
              <span>{t.text}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

// ------------------------------------------------------------------------------------- Table bits
export const Th = ({ children, className, align }: { children?: ReactNode; className?: string; align?: 'right' }) => (
  <th className={cx('px-4 py-2.5 text-left text-xs font-medium tracking-wide text-muted uppercase', align === 'right' && 'text-right', className)}>{children}</th>
);
export const Td = ({ children, className, align }: { children?: ReactNode; className?: string; align?: 'right' }) => (
  <td className={cx('px-4 py-3 align-middle text-sm', align === 'right' && 'text-right', className)}>{children}</td>
);

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-muted">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        await navigator.clipboard?.writeText(text).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}
