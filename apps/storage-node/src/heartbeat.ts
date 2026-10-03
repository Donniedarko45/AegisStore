import type { HeartbeatBody } from '@aegis/shared';
import type { BlobStore } from './blobstore';
import type { Config } from './config';
import type { MetricsCollector } from './metrics';

export function startHeartbeat(
  cfg: Config,
  store: BlobStore,
  metrics: MetricsCollector,
  log: { warn: (o: unknown, m?: string) => void; info: (m: string) => void },
): () => void {
  let registered = false;
  let failing = false;

  const beat = async () => {
    const probeMs = await metrics.probe(cfg.DATA_DIR);
    const body: HeartbeatBody = {
      name: cfg.NODE_NAME,
      baseUrl: cfg.publicUrl,
      metrics: metrics.snapshot(
        { usedBytes: store.usedBytes + store.partsBytes, capacityBytes: cfg.NODE_CAPACITY_BYTES, blobCount: store.blobCount },
        probeMs,
      ),
    };
    try {
      const res = await fetch(`${cfg.API_URL}/internal/nodes/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.NODE_SHARED_SECRET}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`API answered ${res.status}`);
      if (!registered || failing) log.info('heartbeat accepted by control plane');
      registered = true;
      failing = false;
    } catch (err) {
      if (!failing) log.warn({ err: String(err) }, 'heartbeat failed (will keep retrying)');
      failing = true;
    }
  };

  void beat();
  // ±10% jitter so nodes do not beat in lockstep
  let timer: NodeJS.Timeout;
  const schedule = () => {
    const jitter = cfg.HEARTBEAT_INTERVAL_MS * (0.9 + Math.random() * 0.2);
    timer = setTimeout(async () => {
      await beat();
      schedule();
    }, jitter);
  };
  schedule();
  return () => clearTimeout(timer);
}
