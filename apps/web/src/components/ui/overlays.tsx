import { Slider } from '@base-ui/react/slider';
import { Dialog } from '@base-ui/react/dialog';
import { Drawer } from '@base-ui/react/drawer';
import { Menu } from '@base-ui/react/menu';
import { Select } from '@base-ui/react/select';
import { Switch } from '@base-ui/react/switch';
import { Tabs } from '@base-ui/react/tabs';
import { Tooltip } from '@base-ui/react/tooltip';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { cx } from '../../lib/format';
import { Button } from './button';

// ------------------------------------------------------------------------------------- Tooltip
/**
 * 125ms, scale 0.97 -> 1, origin at the trigger. The Provider (in main.tsx) groups tooltips so
 * once one is open, neighbours open instantly with no animation (data-instant).
 */
export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (content === null || content === undefined || content === '') return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6} className="z-[70]">
          <Tooltip.Popup className="max-w-xs origin-[var(--transform-origin)] rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg shadow-popover transition-[transform,opacity] duration-[125ms] ease-out data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            {content}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// --------------------------------------------------------------------------------------- Modal
/** Modals stay centred (not anchored to a trigger): scale 0.96 + fade, 250ms ease-out; backdrop fades with it. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'max-w-[440px]',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-[250ms] ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/70" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
          <Dialog.Popup
            className={cx(
              'w-full rounded-xl bg-surface shadow-popover outline-none transition-[transform,opacity] duration-[250ms] ease-out data-ending-style:scale-[0.96] data-ending-style:opacity-0 data-starting-style:scale-[0.96] data-starting-style:opacity-0',
              width,
            )}
          >
            <div className="flex items-start justify-between gap-4 px-6 pt-5">
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold tracking-tight">{title}</Dialog.Title>
                {description && <Dialog.Description className="mt-1 text-[13px] text-fg-2">{description}</Dialog.Description>}
              </div>
              <Dialog.Close className="pressable -mt-1 -mr-2 grid size-7 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg" aria-label="Close">
                <X className="size-4" />
              </Dialog.Close>
            </div>
            {children && <div className="space-y-4 px-6 py-5">{children}</div>}
            {footer && <div className="flex flex-wrap justify-end gap-2 rounded-b-xl border-t border-line bg-surface-2/50 px-6 py-3">{footer}</div>}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Destructive confirmation. With `confirmText`, the user must type it (Vercel's pattern for
 * irreversible actions); otherwise a plain confirm button.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  confirmText,
  onConfirm,
  busy,
  error,
  tone = 'danger',
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  confirmText?: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: ReactNode;
  tone?: 'danger' | 'primary';
}) {
  const [typed, setTyped] = useState('');
  const ok = !confirmText || typed === confirmText;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped('');
        onOpenChange(o);
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={tone} loading={busy} disabled={!ok} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {confirmText ? (
        <label className="block space-y-1.5 text-[13px]">
          <span className="text-fg-2">
            Type <span className="font-mono font-medium text-fg">{confirmText}</span> to confirm.
          </span>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-full rounded-md bg-surface px-2.5 font-mono text-sm shadow-[0_0_0_1px_var(--border-2)] outline-none focus:shadow-[0_0_0_1px_var(--fg-3),0_0_0_4px_var(--focus)]"
          />
        </label>
      ) : null}
      {children}
      {error}
    </Modal>
  );
}

// ----------------------------------------------------------------------------------- Sheet
/**
 * Right-side sheet on base-ui's Drawer: swipe-to-dismiss with velocity, iOS drawer curve
 * (cubic-bezier(0.32, 0.72, 0, 1)), backdrop follows the swipe progress.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  actions,
  children,
  width = 'w-[min(640px,100vw)]',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <Drawer.Portal>
        <Drawer.Backdrop className="fixed inset-0 z-40 bg-black opacity-[calc(var(--backdrop-opacity)*(1-var(--drawer-swipe-progress)))] transition-opacity duration-[400ms] ease-drawer [--backdrop-opacity:0.25] data-ending-style:opacity-0 data-starting-style:opacity-0 data-swiping:duration-0 dark:[--backdrop-opacity:0.6]" />
        <Drawer.Viewport className="fixed inset-0 z-40 flex items-stretch justify-end">
          <Drawer.Popup
            className={cx(
              'flex h-full max-w-full flex-col bg-surface shadow-popover outline-none [transform:translateX(var(--drawer-swipe-movement-x))] transition-transform duration-[400ms] ease-drawer data-ending-style:[transform:translateX(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*350ms)] data-starting-style:[transform:translateX(100%)] data-swiping:select-none',
              width,
            )}
          >
            <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <Drawer.Title className="truncate text-base font-semibold tracking-tight">{title}</Drawer.Title>
                {description && <Drawer.Description className="mt-0.5 truncate text-xs text-fg-2">{description}</Drawer.Description>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {actions}
                <Drawer.Close className="pressable grid size-8 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg" aria-label="Close panel">
                  <X className="size-4" />
                </Drawer.Close>
              </div>
            </header>
            <Drawer.Content className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

// ---------------------------------------------------------------------------------------- Menu
const popupBase =
  'origin-[var(--transform-origin)] rounded-lg bg-surface p-1 shadow-popover outline-none transition-[transform,opacity] duration-200 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0';
const itemBase =
  'flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-fg outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-2 [&_svg]:size-4 [&_svg]:text-fg-2';

export function DropdownMenu({ trigger, children, align = 'end', width = 'min-w-48' }: { trigger: ReactElement; children: ReactNode; align?: 'start' | 'center' | 'end'; width?: string }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align={align} className="z-[60]">
          <Menu.Popup className={cx(popupBase, width)}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function MenuItem({ children, onClick, danger, disabled }: { children: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <Menu.Item onClick={onClick} disabled={disabled} className={cx(itemBase, danger && 'text-bad-text [&_svg]:!text-bad-text data-highlighted:bg-bad-soft')}>
      {children}
    </Menu.Item>
  );
}
export const MenuSeparator = () => <Menu.Separator className="mx-1 my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="px-2 pt-1.5 pb-1 text-xs text-fg-3">{children}</div>;
export function MenuRadio<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: ReactNode }[] }) {
  return (
    <Menu.RadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
      {options.map((o) => (
        <Menu.RadioItem key={o.value} value={o.value} className={itemBase}>
          {o.icon}
          <span className="flex-1">{o.label}</span>
          <Menu.RadioItemIndicator>
            <Check className="size-3.5" />
          </Menu.RadioItemIndicator>
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

// -------------------------------------------------------------------------------------- Select
export function SelectBox<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <Select.Root items={options} value={value} onValueChange={(v) => v !== null && onChange(v as T)}>
      <Select.Trigger
        aria-label={label}
        className={cx(
          'pressable inline-flex items-center justify-between gap-2 rounded-md bg-surface pr-2 pl-2.5 text-sm text-fg shadow-[0_0_0_1px_var(--border-2)] outline-none hover:bg-surface-2 data-popup-open:bg-surface-2',
          size === 'sm' ? 'h-7 text-[13px]' : 'h-8',
          className,
        )}
      >
        <Select.Value className="truncate" />
        <Select.Icon className="text-fg-3">
          <ChevronsUpDown className="size-3.5" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-[60]">
          <Select.Popup className={cx(popupBase, 'min-w-[var(--anchor-width)]')}>
            <Select.List className="max-h-[var(--available-height)] overflow-y-auto">
              {options.map((o) => (
                <Select.Item key={o.value} value={o.value} className={cx(itemBase, 'pr-7')}>
                  <Select.ItemText className="flex-1">{o.label}</Select.ItemText>
                  <Select.ItemIndicator className="absolute right-2">
                    <Check className="size-3.5" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

// ---------------------------------------------------------------------------------------- Tabs
/** Underline tabs; the indicator slides (transform only, 200ms ease-in-out: on-screen movement). */
export function TabsBar<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <Tabs.Root value={value} onValueChange={(v) => onChange(v as T)} className={className}>
      <Tabs.List className="relative flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
        {tabs.map((t) => (
          <Tabs.Tab
            key={t.value}
            value={t.value}
            className="relative flex h-10 shrink-0 items-center gap-1.5 px-2.5 text-sm text-fg-2 outline-none transition-colors duration-150 ease-[ease] hover:text-fg data-active:text-fg"
          >
            {t.label}
            {t.count !== undefined && <span className="rounded-full bg-surface-2 px-1.5 text-[11px] font-medium text-fg-2 tabular-nums">{t.count.toLocaleString()}</span>}
          </Tabs.Tab>
        ))}
        <Tabs.Indicator className="absolute bottom-0 left-0 h-0.5 w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] rounded-full bg-fg transition-[translate,width] duration-200 ease-in-out" />
      </Tabs.List>
    </Tabs.Root>
  );
}

/** Segmented control for ranges/views: the pill slides between options. */
export function Segmented<T extends string>({ value, onChange, options, label, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string; size?: 'sm' | 'md' }) {
  return (
    <Tabs.Root value={value} onValueChange={(v) => onChange(v as T)} aria-label={label}>
      <Tabs.List className={cx('relative inline-flex rounded-lg bg-surface-2 p-0.5 shadow-[inset_0_0_0_1px_var(--border)]', size === 'sm' ? 'h-7' : 'h-8')}>
        <Tabs.Indicator className="absolute top-0.5 bottom-0.5 left-0 w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] rounded-md bg-surface shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.06)] transition-[translate,width] duration-200 ease-in-out" />
        {options.map((o) => (
          <Tabs.Tab
            key={o.value}
            value={o.value}
            className={cx('relative z-[1] flex items-center gap-1.5 rounded-md px-2.5 text-fg-2 outline-none transition-colors duration-150 ease-[ease] hover:text-fg data-active:text-fg [&_svg]:size-3.5', size === 'sm' ? 'text-xs' : 'text-[13px]')}
          >
            {o.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}

// -------------------------------------------------------------------------------------- Switch
export function SwitchField({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start justify-between gap-6', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] text-fg-2">{description}</span>}
      </span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="relative mt-0.5 flex h-5 w-9 shrink-0 rounded-full bg-surface-3 p-0.5 shadow-[inset_0_0_0_1px_var(--border)] transition-colors duration-150 ease-[ease] data-checked:bg-accent"
      >
        <Switch.Thumb className="size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-200 ease-out data-checked:translate-x-4 dark:data-checked:bg-black" />
      </Switch.Root>
    </label>
  );
}

// --------------------------------------------------------------------------------- HoldButton
/**
 * Hold-to-confirm for rare destructive actions (Emil): the fill is progress, so it is linear and
 * slow (1.5s) while pressing; release snaps back fast (200ms ease-out). Fires on completion.
 */
export function HoldButton({ children, onConfirm, disabled, holdMs = 1500 }: { children: ReactNode; onConfirm: () => void; disabled?: boolean; holdMs?: number }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = () => {
    if (disabled) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      onConfirm();
    }, holdMs);
  };
  const stop = () => {
    clearTimeout(timer.current);
    setHolding(false);
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !e.repeat && start()}
      onKeyUp={stop}
      className="pressable relative h-8 overflow-hidden rounded-md bg-bad-soft px-3 text-sm font-medium text-bad-text select-none disabled:opacity-50"
    >
      <span
        aria-hidden
        className="absolute inset-0 bg-bad"
        style={{
          clipPath: holding ? 'inset(0 0 0 0)' : 'inset(0 100% 0 0)',
          transition: holding ? `clip-path ${holdMs}ms linear` : 'clip-path 200ms var(--ease-out)',
        }}
      />
      <span className="relative mix-blend-normal">{children}</span>
      <span
        aria-hidden
        className="absolute inset-0 flex items-center justify-center px-3 text-white"
        style={{
          clipPath: holding ? 'inset(0 0 0 0)' : 'inset(0 100% 0 0)',
          transition: holding ? `clip-path ${holdMs}ms linear` : 'clip-path 200ms var(--ease-out)',
        }}
      >
        {children}
      </span>
    </button>
  );
}

// ------------------------------------------------------------------------------------ Slider
/**
 * Labelled slider (base-ui). `onCommit` fires once when the user lets go (or per keyboard step),
 * so expensive side effects do not run on every pixel of a drag. No motion: it tracks the pointer.
 */
export function SliderField({
  label,
  value,
  onChange,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  format = (v: number) => String(v),
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  const one = (v: number | readonly number[]) => (Array.isArray(v) ? (v[0] as number) : (v as number));
  return (
    <Slider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(v) => onChange(one(v))}
      onValueCommitted={(v) => onCommit?.(one(v))}
      className={cx('block', disabled && 'opacity-60')}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3 text-[13px]">
        <Slider.Label className="text-fg-2">{label}</Slider.Label>
        <span className="font-medium tabular-nums">{format(value)}</span>
      </div>
      <Slider.Control className="flex h-5 w-full touch-none items-center select-none">
        <Slider.Track className="relative h-1.5 w-full rounded-full bg-surface-3">
          <Slider.Indicator className="rounded-full bg-fg" />
          <Slider.Thumb
            aria-label={label}
            className="size-4 rounded-full bg-surface shadow-[0_0_0_1px_var(--border-2),0_1px_3px_rgb(0_0_0/0.2)] outline-none focus-visible:shadow-[0_0_0_1px_var(--fg-3),0_0_0_4px_var(--focus)]"
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
