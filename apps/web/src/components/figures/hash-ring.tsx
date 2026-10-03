import { useEffect, useMemo, useRef, useState } from 'react';
import type { RingData } from '../../lib/api';
import { cx } from '../../lib/format';
import { entityColor } from '../charts/chart-kit';
import { NodeStatus } from '../ui/primitives';

const SIZE = 320;
const C = SIZE / 2;
const R = 122;
const TAU = Math.PI * 2;
const angle = (pos: number) => pos * TAU - Math.PI / 2; // 0 = 12 o'clock, clockwise
const stepR = (i: number) => R - 26 - i * 22;
const at = (pos: number, r: number) => [C + r * Math.cos(angle(pos)), C + r * Math.sin(angle(pos))] as const;

function arcPath(from: number, to: number, r: number) {
  const span = (to - from + 1) % 1 || (to === from ? 0 : 1);
  const [x1, y1] = at(from, r);
  const [x2, y2] = at(from + span, r);
  const large = span > 0.5 ? 1 : 0;
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

export interface Walk {
  start: number;
  picks: { node: string; pos: number }[];
}

/** Clockwise walk from `start`, picking the first `count` distinct eligible nodes (same as the server). */
export function walkRing(points: RingData['points'], start: number, count: number, eligible: (id: string) => boolean): Walk {
  const n = points.length;
  let i = points.findIndex((p) => p.pos >= start);
  if (i < 0) i = 0;
  const picks: Walk['picks'] = [];
  for (let step = 0; step < n && picks.length < count; step++) {
    const p = points[(i + step) % n]!;
    if (!picks.some((x) => x.node === p.node) && eligible(p.node)) picks.push({ node: p.node, pos: p.pos });
  }
  return { start, picks };
}

/**
 * Interactive consistent-hash ring. Ownership arcs show which node receives keys landing in each
 * stretch of the ring. With a `walk`, the clockwise search from the key to its replica nodes is
 * drawn (explanation: an occasional, longer animation is appropriate here).
 */
export function HashRingFigure({ ring, walk, markerLabel, className }: { ring: RingData; walk?: Walk | null; markerLabel?: string; className?: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const names = useMemo(() => ring.nodes.map((n) => n.name), [ring.nodes]);
  const nameOf = useMemo(() => new Map(ring.nodes.map((n) => [n.id, n.name])), [ring.nodes]);
  const colorOf = (id: string) => entityColor(nameOf.get(id) ?? id, names);

  // merge consecutive vnodes owned by the same node into one arc: keys in (prev, cur] -> cur.node
  const arcs = useMemo(() => {
    const pts = ring.points;
    const out: { node: string; from: number; to: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i]!;
      const prev = pts[(i - 1 + pts.length) % pts.length]!;
      const last = out[out.length - 1];
      if (last && last.node === cur.node) last.to = cur.pos;
      else out.push({ node: cur.node, from: prev.pos, to: cur.pos });
    }
    if (out.length > 1 && out[0]!.node === out[out.length - 1]!.node) {
      out[0]!.from = out.pop()!.from;
    }
    return out;
  }, [ring.points]);

  const walkRef = useRef<SVGGElement>(null);
  useEffect(() => {
    const g = walkRef.current;
    if (!g || !walk) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    g.querySelectorAll<SVGPathElement>('path[data-walk]').forEach((p, i) => {
      const len = p.getTotalLength();
      p.animate([{ strokeDasharray: `${len}`, strokeDashoffset: `${len}` }, { strokeDasharray: `${len}`, strokeDashoffset: '0' }], {
        duration: 900,
        delay: i * 150,
        easing: 'cubic-bezier(0.77, 0, 0.175, 1)',
        fill: 'backwards',
      });
    });
    g.querySelectorAll<SVGGElement>('[data-pick]').forEach((el, i) => {
      el.animate([{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)' }], {
        duration: 260,
        delay: 700 + i * 150,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
        fill: 'backwards',
      });
    });
  }, [walk]);

  const hovered = ring.nodes.find((n) => n.id === hover);
  const total = ring.points.length;

  return (
    <div className={cx('@container', className)}>
    <div className="grid grid-cols-1 items-center gap-6 @xl:grid-cols-[minmax(0,300px)_1fr]">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="mx-auto w-full max-w-[320px]" role="img" aria-label={`Hash ring with ${total} virtual nodes across ${ring.nodes.length} storage nodes`}>
        {/* ownership arcs */}
        <g>
          {arcs.map((a, i) => (
            <path
              key={i}
              d={arcPath(a.from, a.to, R)}
              fill="none"
              stroke={colorOf(a.node)}
              strokeWidth={16}
              className="transition-opacity duration-150 ease-[ease]"
              opacity={hover && hover !== a.node ? 0.18 : 1}
              onPointerEnter={() => setHover(a.node)}
              onPointerLeave={() => setHover(null)}
            />
          ))}
        </g>
        {/* 2px surface ticks at every vnode boundary keep neighbouring arcs distinct */}
        <g stroke="var(--surface)" strokeWidth={1}>
          {ring.points.map((p, i) => {
            const [x1, y1] = at(p.pos, R - 9);
            const [x2, y2] = at(p.pos, R + 9);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} opacity={0.5} />;
          })}
        </g>

        {/* the walk from a key to its replicas */}
        {walk && (
          <g ref={walkRef} key={`${walk.start}-${walk.picks.map((p) => p.node).join()}`}>
            {walk.picks.map((p, i) => {
              // step i travels on its own inner ring, then drops inward to the next step
              const from = i === 0 ? walk.start : walk.picks[i - 1]!.pos;
              const r = stepR(i);
              const [ax, ay] = at(from, i === 0 ? r : stepR(i - 1));
              const [bx, by] = at(from, r);
              return (
                <g key={i}>
                  {i > 0 && <path data-walk d={`M${ax},${ay} L${bx},${by}`} fill="none" stroke="var(--fg)" strokeWidth={1.5} strokeLinecap="round" />}
                  <path data-walk d={arcPath(from, p.pos, r)} fill="none" stroke="var(--fg)" strokeWidth={2} strokeLinecap="round" />
                </g>
              );
            })}
            {(() => {
              const [x, y] = at(walk.start, R + 20);
              const [lx, ly] = at(walk.start, stepR(0));
              return (
                <g>
                  <line x1={x} y1={y} x2={lx} y2={ly} stroke="var(--fg)" strokeWidth={1.5} />
                  <circle cx={x} cy={y} r={5} fill="var(--fg)" stroke="var(--surface)" strokeWidth={2} />
                </g>
              );
            })()}
            {walk.picks.map((p, i) => {
              const [x, y] = at(p.pos, stepR(i));
              return (
                <g key={p.node} data-pick style={{ transformOrigin: `${x}px ${y}px`, transformBox: 'view-box' }}>
                  <circle cx={x} cy={y} r={9} fill={colorOf(p.node)} stroke="var(--surface)" strokeWidth={2} />
                  <text x={x} y={y + 3.5} textAnchor="middle" fontSize={10} fontWeight={600} fill="#fff">
                    {i + 1}
                  </text>
                </g>
              );
            })}
          </g>
        )}

        {/* centre readout */}
        <text x={C} y={C - 6} textAnchor="middle" fontSize={22} fontWeight={600} fill="var(--fg)" className="tabular-nums">
          {hovered ? `${hovered.sharePct}%` : walk ? markerLabel ?? 'key' : total.toLocaleString()}
        </text>
        <text x={C} y={C + 14} textAnchor="middle" fontSize={11} fill="var(--fg-2)">
          {hovered ? `of keys -> ${hovered.name}` : walk ? `-> ${walk.picks.length} replica${walk.picks.length === 1 ? '' : 's'}` : 'virtual nodes'}
        </text>
      </svg>

      {/* legend doubles as the table view: every number is readable without hovering */}
      <ul className="space-y-1">
        {ring.nodes.map((n) => {
          const pickIdx = walk?.picks.findIndex((p) => p.node === n.id) ?? -1;
          return (
            <li
              key={n.id}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover(null)}
              className={cx('flex items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-150 ease-[ease]', hover === n.id && 'bg-surface-2')}
            >
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colorOf(n.id) }} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{n.name}</span>
                  {pickIdx >= 0 && <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[10.5px] font-medium text-accent-fg">replica {pickIdx + 1}</span>}
                </span>
                <span className="block text-xs whitespace-nowrap text-fg-2 tabular-nums">
                  {n.sharePct}% of keys · {ring.vnodesPerNode} vnodes
                </span>
              </span>
              <NodeStatus status={n.status} />
            </li>
          );
        })}
      </ul>
    </div>
    </div>
  );
}
