import { Cpu } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NodeDto } from '../../lib/api';
import { useLive } from '../../lib/live';
import { cx, formatBytes } from '../../lib/format';
import { nodeLabel, nodeTone } from '../ui/primitives';

const W = 360;
const H = 240;
const HUB = { x: W / 2, y: 62 };
const toneVar = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--info)', neutral: 'var(--fg-3)' } as const;

/**
 * Live cluster topology. Every heartbeat that arrives over SSE sends a pulse from the node to the
 * control plane (state indication: you can see the cluster is alive). Offline links are drawn
 * broken. Reduced motion: the pulse is replaced by a brief fade on the node.
 */
export function Topology({ nodes }: { nodes: NodeDto[] }) {
  const navigate = useNavigate();
  const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));
  const n = Math.max(1, sorted.length);
  const pos = sorted.map((_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    return { x: 54 + t * (W - 108), y: H - 54 };
  });
  const svgRef = useRef<SVGSVGElement>(null);
  const lastBeat = useLive((s) => s.lastBeat);
  const prev = useRef<Record<string, number>>({});

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const [name, t] of Object.entries(lastBeat)) {
      if (prev.current[name] === t) continue;
      prev.current[name] = t;
      const i = sorted.findIndex((x) => x.name === name);
      if (i < 0) continue;
      const p = pos[i]!;
      if (reduce) {
        svg.querySelector(`[data-node="${CSS.escape(name)}"]`)?.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 300, easing: 'ease' });
        continue;
      }
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '3.5');
      dot.setAttribute('fill', 'var(--series-1)');
      svg.appendChild(dot);
      const anim = dot.animate(
        [
          { transform: `translate(${p.x}px, ${p.y - 22}px)`, opacity: 0 },
          { transform: `translate(${p.x}px, ${p.y - 22}px)`, opacity: 1, offset: 0.1 },
          { transform: `translate(${HUB.x}px, ${HUB.y + 22}px)`, opacity: 1, offset: 0.9 },
          { transform: `translate(${HUB.x}px, ${HUB.y + 22}px)`, opacity: 0 },
        ],
        { duration: 900, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' },
      );
      anim.onfinish = () => dot.remove();
    }
  }, [lastBeat, sorted, pos]);

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Cluster: ${sorted.map((s) => `${s.name} ${nodeLabel(s.status)}`).join(', ')}`}>
      {sorted.map((node, i) => {
        const p = pos[i]!;
        const off = node.status === 'OFFLINE';
        return (
          <line
            key={`l-${node.id}`}
            x1={p.x}
            y1={p.y - 22}
            x2={HUB.x}
            y2={HUB.y + 22}
            stroke={off ? 'var(--bad)' : 'var(--axis)'}
            strokeWidth={1.5}
            strokeDasharray={off ? '4 5' : undefined}
            opacity={off ? 0.7 : 1}
          />
        );
      })}

      {/* control plane */}
      <g>
        <rect x={HUB.x - 74} y={HUB.y - 22} width={148} height={44} rx={10} fill="var(--surface)" stroke="var(--border-2)" />
        <foreignObject x={HUB.x - 74} y={HUB.y - 22} width={148} height={44}>
          <div className="flex h-full items-center justify-center gap-2 text-[12px] font-medium text-fg">
            <Cpu className="size-4 text-fg-2" /> Control plane
          </div>
        </foreignObject>
      </g>

      {sorted.map((node, i) => {
        const p = pos[i]!;
        const tone = nodeTone(node.status);
        const usedPct = node.capacityBytes ? (node.usedBytes / node.capacityBytes) * 100 : 0;
        return (
          <g key={node.id} data-node={node.name} className="cursor-pointer" onClick={() => navigate(`/nodes?node=${encodeURIComponent(node.id)}`)}>
            <rect x={p.x - 50} y={p.y - 22} width={100} height={64} rx={10} fill="var(--surface)" stroke={node.status === 'HEALTHY' ? 'var(--border-2)' : toneVar[tone]} />
            <foreignObject x={p.x - 50} y={p.y - 22} width={100} height={64}>
              <div className="flex h-full flex-col justify-center px-2.5 text-[11px] leading-tight">
                <div className="flex items-center gap-1.5 font-medium text-fg">
                  <span className={cx('size-1.5 rounded-full', { good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', neutral: 'bg-fg-3' }[tone])} />
                  <span className="truncate">{node.name.replace('storage-', '')}</span>
                </div>
                <div className="mt-0.5 text-fg-2">{nodeLabel(node.status)}</div>
                <div className="text-fg-3 tabular-nums">
                  {formatBytes(node.usedBytes)} · {usedPct.toFixed(1)}%
                </div>
              </div>
            </foreignObject>
          </g>
        );
      })}
    </svg>
  );
}
