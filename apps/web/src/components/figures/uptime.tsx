import type { UptimeData } from '../../lib/api';
import { cx, formatDateTime, formatDuration, formatTime } from '../../lib/format';
import { Tip } from '../ui/overlays';
import { NodeStatus } from '../ui/primitives';

function barColor(up: number | null) {
  if (up === null) return 'bg-surface-3';
  if (up >= 99.9) return 'bg-good';
  if (up >= 50) return 'bg-warn';
  return 'bg-bad';
}

/** Status-page availability: one bar per time slice; each bar is its own hit target with a tooltip. */
export function UptimeBars({ data }: { data: UptimeData }) {
  return (
    <div className="space-y-5">
      {data.nodes.map((n) => (
        <div key={n.id}>
          <div className="mb-2 flex items-center gap-3">
            <span className="text-sm font-medium">{n.name}</span>
            <NodeStatus status={n.status} />
            <span className="ml-auto text-[13px] text-fg-2 tabular-nums">{n.uptimePct === null ? 'no data' : `${n.uptimePct.toFixed(2)}% uptime`}</span>
          </div>
          <div className="flex h-7 items-stretch gap-[2px]" role="img" aria-label={`${n.name} availability over ${data.range}`}>
            {n.bars.map((b) => (
              <Tip key={b.t} content={`${formatTime(b.t)} · ${b.upPct === null ? 'not registered' : `${b.upPct}% up`}`}>
                <span className={cx('min-w-0 flex-1 rounded-[2px] transition-opacity duration-150 ease-[ease] hover:opacity-70', barColor(b.upPct))} />
              </Tip>
            ))}
          </div>
          {n.incidents.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {n.incidents.slice(0, 3).map((inc) => (
                <li key={inc.start} className="flex items-center gap-2 text-xs text-fg-2">
                  <span className="size-1.5 rounded-full bg-bad" aria-hidden />
                  Offline {formatDateTime(inc.start)} · {inc.end ? `for ${formatDuration(inc.durationSec)}` : <span className="font-medium text-bad-text">ongoing</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <div className="flex items-center gap-4 text-xs text-fg-2">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-good" /> Operational</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-warn" /> Partial outage</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-bad" /> Offline</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-surface-3" /> No data</span>
      </div>
    </div>
  );
}
