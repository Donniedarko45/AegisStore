import { sql, type Db } from '@aegis/db';

/** Copy each live node's latest heartbeat metrics into the time series (feeds charts + risk scoring). */
export async function rollupMetrics(db: Db): Promise<void> {
  await db.execute(sql`
    INSERT INTO node_metrics (node_id, cpu_pct, mem_pct, disk_used_pct, latency_ms_p50, latency_ms_p95, error_rate, blob_count, probe_ms)
    SELECT id,
           coalesce((last_metrics->>'cpuPct')::real, 0),
           coalesce((last_metrics->>'memPct')::real, 0),
           coalesce((last_metrics->>'diskUsedPct')::real, 0),
           coalesce((last_metrics->>'latencyMsP50')::real, 0),
           coalesce((last_metrics->>'latencyMsP95')::real, 0),
           coalesce((last_metrics->>'errorRate')::real, 0),
           coalesce((last_metrics->>'blobCount')::int, 0),
           coalesce((last_metrics->>'probeMs')::real, 0)
      FROM storage_nodes
     WHERE status <> 'OFFLINE' AND last_metrics IS NOT NULL
       AND last_heartbeat_at > now() - interval '30 seconds'`);
}
