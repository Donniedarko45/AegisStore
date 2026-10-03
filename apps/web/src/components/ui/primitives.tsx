import NumberFlow from '@number-flow/react';
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Copy, Info, XCircle } from 'lucide-react';
import { forwardRef, useEffect, useId, useState, type ComponentProps, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { bytesParts, cx, formatDateTime, hueFor, initials, relativeTime } from '../../lib/format';
import { Tip } from './overlays';

// ---------------------------------------------------------------------------------- surfaces
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card({ className, ...p }, ref) {
  return <div ref={ref} className={cx('rounded-xl bg-surface shadow-card', className)} {...p} />;
});

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start justify-between gap-4 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-medium tracking-tight">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-fg-2">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-[13px] text-fg-2">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-[-0.02em] break-words [overflow-wrap:anywhere]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-fg-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export const Separator = ({ className }: { className?: string }) => <div role="separator" className={cx('h-px bg-line', className)} />;

// ------------------------------------------------------------------------------------- inputs
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        'h-8 w-full min-w-0 rounded-md bg-surface px-2.5 text-sm text-fg shadow-[0_0_0_1px_var(--border-2)] transition-shadow duration-150 ease-[ease] placeholder:text-fg-3 focus:shadow-[0_0_0_1px_var(--fg-3),0_0_0_4px_var(--focus)] focus:outline-none disabled:opacity-60',
        className,
      )}
      {...p}
    />
  );
});

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-fg">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="flex items-center gap-1 text-xs text-bad-text">
          <AlertCircle className="size-3.5" /> {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-2">{hint}</p>
      ) : null}
    </div>
  );
}

export const Kbd = ({ children, className }: { children: ReactNode; className?: string }) => (
  <kbd className={cx('inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-sans text-[11px] font-medium text-fg-2', className)}>{children}</kbd>
);

// ---------------------------------------------------------------------------------- status & badges
export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
const toneClass: Record<Tone, string> = {
  good: 'bg-good-soft text-good-text',
  warn: 'bg-warn-soft text-warn-text',
  bad: 'bg-bad-soft text-bad-text',
  info: 'bg-info-soft text-info-text',
  neutral: 'bg-surface-2 text-fg-2 shadow-[inset_0_0_0_1px_var(--border)]',
};
const toneIcon = { good: CheckCircle2, warn: AlertTriangle, bad: XCircle, info: Info, neutral: null } as const;

/** Status never relies on colour alone: optional icon + always a text label. */
export function Badge({ tone = 'neutral', children, icon, className }: { tone?: Tone; children: ReactNode; icon?: boolean; className?: string }) {
  const Icon = icon ? toneIcon[tone] : null;
  return (
    <span className={cx('inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap', toneClass[tone], className)}>
      {Icon && <Icon className="-ml-0.5 size-3" aria-hidden />}
      {children}
    </span>
  );
}

const dotColor: Record<Tone, string> = { good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', neutral: 'bg-fg-3' };
export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cx('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {pulse && <span className={cx('motion-safe-only absolute inset-0 rounded-full animate-[pulse-ring_1.6s_var(--ease-out)_infinite]', dotColor[tone])} />}
      <span className={cx('relative size-2 rounded-full', dotColor[tone])} />
    </span>
  );
}

export const nodeTone = (s: string): Tone => (({ HEALTHY: 'good', WARNING: 'warn', HIGH_RISK: 'bad', OFFLINE: 'bad', DRAINING: 'info' }) as Record<string, Tone>)[s] ?? 'neutral';
export const nodeLabel = (s: string) => (({ HEALTHY: 'Healthy', WARNING: 'Warning', HIGH_RISK: 'High risk', OFFLINE: 'Offline', DRAINING: 'Draining' }) as Record<string, string>)[s] ?? s;
export const integrityTone = (s: string): Tone => (({ HEALTHY: 'good', DEGRADED: 'warn', UNAVAILABLE: 'bad' }) as Record<string, Tone>)[s] ?? 'neutral';
export const integrityLabel = (s: string) => (({ HEALTHY: 'Healthy', DEGRADED: 'Degraded', UNAVAILABLE: 'Unavailable' }) as Record<string, string>)[s] ?? s;

export function NodeStatus({ status }: { status: string }) {
  return (
    <Badge tone={nodeTone(status)}>
      <StatusDot tone={nodeTone(status)} />
      {nodeLabel(status)}
    </Badge>
  );
}

// --------------------------------------------------------------------------------------- meter
export function Meter({ value, max = 100, tone, className, label }: { value: number; max?: number; tone?: Tone; className?: string; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const t: Tone = tone ?? (pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'info');
  return (
    <div role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} className={cx('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}>
      {/* scaleX (GPU) rather than width; origin left */}
      <div className={cx('h-full w-full origin-left rounded-full transition-transform duration-300 ease-out', dotColor[t])} style={{ transform: `scaleX(${pct / 100})` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------- numbers & time
/** Animated number (NumberFlow): digits roll on change; respects reduced motion. */
type NumberFormat = ComponentProps<typeof NumberFlow>['format'];
export function Num({ value, format, suffix, prefix, className }: { value: number; format?: NumberFormat; suffix?: string; prefix?: string; className?: string }) {
  return <NumberFlow value={value} format={format} suffix={suffix} prefix={prefix} className={className} />;
}

export function Bytes({ value, className }: { value: number; className?: string }) {
  const p = bytesParts(value);
  return <NumberFlow value={p.value} suffix={` ${p.unit}`} format={{ minimumFractionDigits: p.digits, maximumFractionDigits: p.digits }} className={className} />;
}

/** Relative time that stays current and shows the exact timestamp on hover. */
export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return <span className={className}>never</span>;
  return (
    <Tip content={formatDateTime(iso)}>
      <time dateTime={iso} className={cx('cursor-default', className)}>
        {relativeTime(iso)}
      </time>
    </Tip>
  );
}

// -------------------------------------------------------------------------------------- avatar
export function Avatar({ name, email, size = 28, className }: { name?: string | null; email?: string | null; size?: number; className?: string }) {
  const h = hueFor(email ?? name ?? '?');
  return (
    <span
      aria-hidden
      className={cx('inline-grid shrink-0 place-items-center rounded-full font-medium text-white select-none', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size * 0.38),
        background: `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 75% 45%))`,
      }}
    >
      {initials(name, email)}
    </span>
  );
}

// ------------------------------------------------------------------------------- copy button
/** Copy with an icon swap; the swap is blurred so it reads as one morph, not two icons. */
export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tip content={done ? 'Copied' : label}>
      <button
        type="button"
        aria-label={label}
        onClick={async () => {
          await navigator.clipboard?.writeText(text).catch(() => undefined);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }}
        className={cx('pressable relative inline-grid size-7 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg', className)}
      >
        <Copy className={cx('absolute size-3.5 transition-[opacity,filter,transform] duration-200 ease-out', done && 'scale-75 opacity-0 blur-[2px]')} />
        <Check className={cx('absolute size-3.5 text-good-text transition-[opacity,filter,transform] duration-200 ease-out', !done && 'scale-75 opacity-0 blur-[2px]')} />
      </button>
    </Tip>
  );
}

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => (
  <code className={cx('font-mono text-[12.5px] [overflow-wrap:anywhere]', className)}>{children}</code>
);

// ---------------------------------------------------------------------------------- states
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cx('relative overflow-hidden rounded-md bg-surface-2', className)}>
      <div className="motion-safe-only absolute inset-0 -translate-x-full animate-[shimmer_1.4s_linear_infinite] bg-gradient-to-r from-transparent via-[var(--border)] to-transparent" />
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="mb-4 grid size-11 place-items-center rounded-xl bg-surface text-fg-2 shadow-raised [&_svg]:size-5">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-fg-2">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cx('flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2.5 text-[13px] text-bad-text', className)}>
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="[overflow-wrap:anywhere]">{msg}</span>
    </div>
  );
}

// --------------------------------------------------------------------------------- table bits
export const Th = ({ children, className, align }: { children?: ReactNode; className?: string; align?: 'right' }) => (
  <th className={cx('h-9 px-4 text-left text-xs font-medium whitespace-nowrap text-fg-2', align === 'right' && 'text-right', className)}>{children}</th>
);
export const Td = ({ children, className, align, colSpan }: { children?: ReactNode; className?: string; align?: 'right'; colSpan?: number }) => (
  <td colSpan={colSpan} className={cx('h-12 px-4 align-middle text-sm', align === 'right' && 'text-right', className)}>
    {children}
  </td>
);
