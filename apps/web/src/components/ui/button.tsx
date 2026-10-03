import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cx } from '../../lib/format';
import { Spinner } from './spinner';

export const buttonStyles = cva(
  'pressable relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium select-none outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
        secondary: 'bg-surface text-fg shadow-[0_0_0_1px_var(--border-2)] hover:bg-surface-2',
        ghost: 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        danger: 'bg-bad text-white hover:brightness-110',
        'danger-ghost': 'text-bad-text hover:bg-bad-soft',
      },
      size: {
        sm: 'h-7 px-2.5 text-[13px]',
        md: 'h-8 px-3 text-sm',
        lg: 'h-10 px-4 text-sm',
        icon: 'size-8',
        'icon-sm': 'size-7 [&_svg]:size-[15px]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {
  loading?: boolean;
}

/**
 * Press feedback: scale(0.97) on :active (160ms, strong ease-out).
 * Loading: the label blurs/fades while a fast spinner overlays it, so the width never jumps.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={cx(buttonStyles({ variant, size }), className)} {...rest}>
      <span
        className={cx(
          'inline-flex items-center gap-1.5 transition-[filter,opacity] duration-200 ease-[ease]',
          loading && 'opacity-0 blur-[2px]',
        )}
      >
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner className="size-4" />
        </span>
      )}
    </button>
  );
});
