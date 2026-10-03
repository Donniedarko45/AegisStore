import { BarChart3, Table2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cx, formatDay, formatTime } from '../../lib/format';
import { Card, Th, Td } from '../ui/primitives';
import { Segmented } from '../ui/overlays';

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'] as const;

/** Colour follows the entity: node colours come from the node's sorted position, never its rank. */
export function entityColor(name: string, all: string[]): string {
  const i = [...all].sort().indexOf(name);
  return SERIES[i >= 0 ? i % SERIES.length : 0]!;
}

export interface Series {
  key: string;
  label: string;
  color: string;
}

type Row = { t: string };

export function timeTick(range: string) {
  return (v: string) => (range === '7d' || range === '30d' ? formatDay(v) : formatTime(v));
}

// ------------------------------------------------------------------------------------ tooltip
/** One tooltip, every series; values lead, labels follow; series keyed by a short line. */
function TooltipCard({ active, payload, label, series, format, labelFormat, hidden }: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | string }[];
  label?: string;
  series: Series[];
  format: (v: number) => string;
  labelFormat: (v: string) => string;
  hidden: Set<string>;
}) {
  if (!active || !payload?.length || label === undefined) return null;
  const byKey = new Map(payload.map((p) => [String(p.dataKey), p.value]));
  return (
    <div className="min-w-40 rounded-lg bg-surface px-3 py-2 text-xs shadow-popover">
      <div className="mb-1.5 text-fg-2">{labelFormat(label)}</div>
      <div className="space-y-1">
        {series
          .filter((s) => !hidden.has(s.key))
          .map((s) => {
            const v = byKey.get(s.key);
            return (
              <div key={s.key} className="flex items-center gap-2">
                <span className="h-0.5 w-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
                <span className="font-medium text-fg tabular-nums">{v === null || v === undefined ? '—' : format(Number(v))}</span>
                <span className="ml-auto pl-3 text-fg-2">{s.label}</span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------- legend
export function Legend({ series, hidden, onToggle, mark = 'line' }: { series: Series[]; hidden?: Set<string>; onToggle?: (k: string) => void; mark?: 'line' | 'rect' }) {
  if (series.length < 2) return null; // a single series is named by the chart title
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {series.map((s) => {
        const off = hidden?.has(s.key);
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onToggle?.(s.key)}
            aria-pressed={!off}
            className={cx('pressable flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-fg-2 hover:text-fg', off && 'opacity-40')}
          >
            <span className={mark === 'line' ? 'h-0.5 w-3 rounded-full' : 'size-2.5 rounded-[3px]'} style={{ background: s.color }} aria-hidden />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------- chart card
/**
 * Every chart ships a table-view twin (values never gated behind hover) and keeps its previous
 * render at reduced opacity while refetching (no skeleton flash, no layout jump).
 */
export function ChartCard({
  title,
  description,
  value,
  action,
  fetching,
  table,
  children,
  className,
  legend,
}: {
  title: string;
  description?: ReactNode;
  value?: ReactNode;
  action?: ReactNode;
  fetching?: boolean;
  table?: { columns: string[]; rows: (string | number)[][] };
  children: ReactNode;
  className?: string;
  legend?: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <Card className={cx('flex min-w-0 flex-col', className)}>
      <div className="flex items-start justify-between gap-4 px-5 pt-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium tracking-tight">{title}</h3>
          {description && <p className="mt-0.5 text-[13px] text-fg-2">{description}</p>}
          {value && <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {table && (
            <Segmented
              size="sm"
              label={`${title} view`}
              value={view}
              onChange={setView}
              options={[
                { value: 'chart', label: <BarChart3 aria-label="Chart view" /> },
                { value: 'table', label: <Table2 aria-label="Table view" /> },
              ]}
            />
          )}
        </div>
      </div>
      {legend && <div className="px-4 pt-2">{legend}</div>}
      <div className={cx('min-h-0 flex-1 px-2 pt-2 pb-3 transition-opacity duration-200 ease-[ease]', fetching && 'opacity-60')}>
        {view === 'chart' || !table ? (
          children
        ) : (
          <div className="max-h-72 overflow-auto px-3">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-line">
                  {table.columns.map((c, i) => (
                    <Th key={c} align={i > 0 ? 'right' : undefined} className="px-2">
                      {c}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {table.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <Td key={j} align={j > 0 ? 'right' : undefined} className="h-9 px-2 tabular-nums">
                        {c}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------- time series
const axisProps = {
  stroke: 'var(--fg-3)',
  tickLine: false,
  axisLine: false,
  fontSize: 11,
  tick: { fill: 'var(--fg-3)' },
} as const;

/**
 * Line / area / stacked-bar over time. Functional data: no draw-in animation, crisp 2px lines,
 * solid hairline grid, crosshair snapping to the nearest point, one y-axis only.
 */
export function TimeSeries({
  data,
  series,
  kind = 'area',
  format,
  axisFormat,
  labelFormat,
  height = 220,
  hidden = new Set<string>(),
  syncId,
  stacked,
  yDomain,
  references = [],
}: {
  data: Row[];
  series: Series[];
  kind?: 'area' | 'line' | 'bar';
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  labelFormat: (v: string) => string;
  height?: number;
  hidden?: Set<string>;
  syncId?: string;
  stacked?: boolean;
  yDomain?: [number | string, number | string];
  /** horizontal thresholds (dashed hairline + label), e.g. risk levels */
  references?: { y: number; label: string }[];
}) {
  const visible = series.filter((s) => !hidden.has(s.key));
  const refs = references.map((r) => (
    <ReferenceLine
      key={r.label}
      y={r.y}
      stroke="var(--axis)"
      strokeDasharray="4 4"
      ifOverflow="extendDomain"
      label={{ value: r.label, position: 'insideTopLeft', fill: 'var(--fg-3)', fontSize: 11 }}
    />
  ));
  const tickEvery = Math.max(1, Math.ceil(data.length / 6));
  const xTicks = useMemo(() => data.filter((_, i) => i % tickEvery === 0).map((d) => d.t), [data, tickEvery]);
  const common = { data, margin: { top: 8, right: 12, bottom: 0, left: 4 }, syncId } as const;
  const grid = <CartesianGrid vertical={false} stroke="var(--grid)" strokeDasharray="0" />;
  const xAxis = <XAxis dataKey="t" ticks={xTicks} tickFormatter={labelFormat} {...axisProps} minTickGap={24} dy={6} />;
  const yAxis = <YAxis {...axisProps} width={56} tickFormatter={axisFormat ?? format} domain={yDomain ?? [0, 'auto']} allowDecimals={false} tickCount={4} />;
  const tooltip = (
    <Tooltip
      cursor={kind === 'bar' ? { fill: 'var(--surface-2)' } : { stroke: 'var(--axis)', strokeWidth: 1 }}
      isAnimationActive={false}
      content={(p) => (
        <TooltipCard
          active={p.active}
          payload={p.payload as unknown as { dataKey?: string; value?: number }[] | undefined}
          label={p.label as string | undefined}
          series={series}
          format={format}
          labelFormat={(v) => `${formatDay(v)}, ${formatTime(v)}`}
          hidden={hidden}
        />
      )}
    />
  );
  const activeDot = { r: 4, strokeWidth: 2, stroke: 'var(--surface)' };

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {kind === 'bar' ? (
          <BarChart {...common} barCategoryGap="22%">
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {refs}
            {visible.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId={stacked ? 'a' : undefined}
                fill={s.color}
                maxBarSize={24}
                // round only the data end of the top segment; the surface-coloured stroke is the 2px gap
                radius={!stacked || i === visible.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                stroke="var(--surface)"
                strokeWidth={stacked ? 1 : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        ) : kind === 'line' ? (
          <LineChart {...common}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {refs}
            {visible.map((s) => (
              <Line key={s.key} dataKey={s.key} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ ...activeDot, fill: s.color }} type="monotone" isAnimationActive={false} connectNulls />
            ))}
          </LineChart>
        ) : (
          <AreaChart {...common}>
            <defs>
              {visible.map((s) => (
                <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {refs}
            {visible.map((s) => (
              <Area
                key={s.key}
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                fill={`url(#fill-${s.key})`}
                type="monotone"
                stackId={stacked ? 'a' : undefined}
                activeDot={{ ...activeDot, fill: s.color }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** Legend toggles that keep colours attached to entities. */
export function useHidden() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return { hidden, toggle };
}

// ------------------------------------------------------------------------------------ bar list
/** Ranked list with proportional bars (one series = one colour). Labels never wear the data colour. */
export function BarList({ items, format, empty = 'No data yet', onSelect }: { items: { label: ReactNode; value: number; key: string; sub?: ReactNode }[]; format: (v: number) => string; empty?: string; onSelect?: (key: string) => void }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="px-5 py-8 text-center text-[13px] text-fg-3">{empty}</p>;
  return (
    <ul className="space-y-1 px-3 pb-2">
      {items.map((i) => {
        const Comp = onSelect ? 'button' : 'div';
        return (
          <li key={i.key}>
            <Comp
              {...(onSelect ? { type: 'button' as const, onClick: () => onSelect(i.key) } : {})}
              className={cx('group relative flex h-8 w-full items-center gap-3 rounded-md px-2 text-left text-[13px]', onSelect && 'pressable hover:bg-surface-2')}
            >
              <span
                aria-hidden
                className="absolute inset-y-1 left-0 origin-left rounded bg-[var(--series-1)] opacity-[0.12]"
                style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }}
              />
              <span className="relative min-w-0 flex-1 truncate text-fg">{i.label}</span>
              {i.sub && <span className="relative shrink-0 text-xs text-fg-3">{i.sub}</span>}
              <span className="relative shrink-0 font-medium tabular-nums">{format(i.value)}</span>
            </Comp>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------------------ part-to-whole
/** Horizontal part-to-whole bar with 2px surface gaps; status meaning carried by icon + label too. */
export function SegmentBar({ parts, total }: { parts: { key: string; label: string; value: number; color: string; icon?: ReactNode }[]; total?: number }) {
  const sum = total ?? parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="space-y-3">
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-2" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
        {sum > 0 &&
          parts
            .filter((p) => p.value > 0)
            .map((p) => <div key={p.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flexGrow: p.value, flexBasis: 0, background: p.color }} />)}
      </div>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5 text-[13px]">
            {p.icon ?? <span className="size-2 rounded-full" style={{ background: p.color }} />}
            <span className="text-fg-2">{p.label}</span>
            <span className="ml-auto font-medium tabular-nums sm:ml-1">{p.value.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------------------------ sparkline
export function Sparkline({ values, height = 32, className }: { values: number[]; height?: number; className?: string }) {
  if (values.length < 2) return <div style={{ height }} className={className} />;
  const w = 120;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={cx('w-full overflow-visible', className)} style={{ height }} aria-hidden>
      <path d={`${d} L${w},${height} L0,${height} Z`} fill="var(--series-1)" opacity={0.08} />
      <path d={d} fill="none" stroke="var(--fg-3)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
