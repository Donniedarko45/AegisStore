/**
 * Fault injection for the Simulation Lab (architecture §9.8). The control plane drives it through
 * the authenticated internal API, so no Docker socket is ever mounted into the API container.
 *
 *  offline      stop heartbeats and refuse every blob request (looks like a crashed/partitioned node)
 *  latencyMs    add delay to blob requests and to the disk probe (slow disk / network)
 *  errorRate    fail this share of blob requests and probes with 500 (failing media)
 *  diskFillPct  report the disk as at least this full, and refuse writes beyond it (virtual fill)
 */
export interface ChaosState {
  offline: boolean;
  latencyMs: number;
  errorRate: number;
  diskFillPct: number;
}

export class Chaos {
  state: ChaosState = { offline: false, latencyMs: 0, errorRate: 0, diskFillPct: 0 };

  set(patch: Partial<ChaosState>): ChaosState {
    const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    this.state = {
      offline: patch.offline === undefined ? this.state.offline : !!patch.offline,
      latencyMs: patch.latencyMs === undefined ? this.state.latencyMs : clamp(patch.latencyMs, 0, 10_000, 0),
      errorRate: patch.errorRate === undefined ? this.state.errorRate : clamp(patch.errorRate, 0, 1, 0),
      diskFillPct: patch.diskFillPct === undefined ? this.state.diskFillPct : clamp(patch.diskFillPct, 0, 100, 0),
    };
    return this.state;
  }

  get active(): boolean {
    const s = this.state;
    return s.offline || s.latencyMs > 0 || s.errorRate > 0 || s.diskFillPct > 0;
  }

  /** delay with ±20% jitter so injected latency looks like real latency */
  async delay(): Promise<void> {
    const ms = this.state.latencyMs;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms * (0.8 + Math.random() * 0.4)));
  }

  shouldFail(): boolean {
    return this.state.errorRate > 0 && Math.random() < this.state.errorRate;
  }

  /** bytes the disk should appear to use at least, given its capacity */
  virtualUsed(capacity: number): number {
    return Math.round((this.state.diskFillPct / 100) * capacity);
  }
}
