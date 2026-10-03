import { randomBytes } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NodeMetrics } from '@aegis/shared';
import type { Chaos } from './chaos';

const WINDOW_MS = 60_000;

interface Sample {
  at: number;
  /** null: counted for the error rate only (bulk transfers are not a latency signal) */
  ms: number | null;
  error: boolean;
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/** Rolling request latency / error stats plus host CPU and memory. */
export class MetricsCollector {
  private samples: Sample[] = [];
  private lastCpu = cpuTimes();

  record(ms: number | null, error: boolean) {
    this.samples.push({ at: Date.now(), ms, error });
    if (this.samples.length > 5000) this.samples.splice(0, this.samples.length - 5000);
  }

  private cpuPct(): number {
    const now = cpuTimes();
    const idle = now.idle - this.lastCpu.idle;
    const total = now.total - this.lastCpu.total;
    this.lastCpu = now;
    return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
  }

  /**
   * Disk health probe: write 4 KB, fsync, read it back and delete it. Request latency only exists
   * when there is traffic; the probe gives a real I/O latency signal even on an idle node.
   */
  async probe(dataDir: string, chaos?: Chaos): Promise<number> {
    const file = path.join(dataDir, 'tmp', '.probe');
    const t0 = performance.now();
    try {
      // injected faults affect the probe like they affect real I/O (so an idle node shows them too)
      await chaos?.delay();
      if (chaos?.shouldFail()) throw new Error('injected I/O error');
      const fh = await open(file, 'w');
      await fh.write(randomBytes(4096));
      await fh.sync();
      await fh.close();
      await readFile(file);
      await unlink(file);
      this.record(null, false);
      return Math.round((performance.now() - t0) * 100) / 100;
    } catch {
      this.record(null, true); // a failed probe counts toward the error rate
      return -1; // reported as an error rather than a fake latency
    }
  }

  snapshot(disk: { usedBytes: number; capacityBytes: number; blobCount: number }, probeMs?: number): NodeMetrics {
    const cutoff = Date.now() - WINDOW_MS;
    this.samples = this.samples.filter((s) => s.at >= cutoff);
    const times = this.samples.flatMap((s) => (s.ms === null ? [] : [s.ms])).sort((a, b) => a - b);
    const pick = (p: number) => (times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))]! : 0);
    const errors = this.samples.filter((s) => s.error).length;
    const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
    return {
      cpuPct: round(this.cpuPct()),
      memPct: round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
      diskUsedBytes: disk.usedBytes,
      diskCapacityBytes: disk.capacityBytes,
      diskUsedPct: round((disk.usedBytes / disk.capacityBytes) * 100),
      latencyMsP50: round(pick(0.5)),
      latencyMsP95: round(pick(0.95)),
      errorRate: this.samples.length ? round(errors / this.samples.length, 4) : 0,
      blobCount: disk.blobCount,
      uptimeSec: Math.round(process.uptime()),
      ...(probeMs !== undefined && probeMs >= 0 && { probeMs }),
    };
  }
}
