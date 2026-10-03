import { cx } from '../../lib/format';

/** A fast spinner (600ms/turn): spinning faster makes loading feel faster. */
export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" role="status" aria-label={label} className={cx('size-4 animate-[spin_600ms_linear_infinite]', className)}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
