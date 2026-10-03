import { z } from 'zod';
import { DEFAULTS, envInt, parseEnv } from '@aegis/shared';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  NODE_SHARED_SECRET: z.string().min(8),
  OFFLINE_AFTER_MS: envInt(DEFAULTS.offlineAfterMs),
  HEARTBEAT_INTERVAL_MS: envInt(DEFAULTS.heartbeatIntervalMs),
  VNODES_PER_NODE: envInt(DEFAULTS.vnodesPerNode),
  SWEEP_INTERVAL_MS: envInt(5000),
  METRICS_ROLLUP_INTERVAL_MS: envInt(30_000),
  GC_INTERVAL_MS: envInt(10 * 60_000),
  PURGE_INTERVAL_MS: envInt(60_000),
  METRICS_RETENTION_DAYS: envInt(7),
  /** predictive risk scoring (§9.1) */
  RISK_INTERVAL_MS: envInt(10_000),
  /** self-healing (§9.2) */
  RECONCILE_INTERVAL_MS: envInt(10_000),
  JOB_POLL_MS: envInt(1000),
  REPAIR_CONCURRENCY: envInt(2),
  /** do not re-replicate away from an OFFLINE node until it has been gone this long */
  HEAL_GRACE_MS: envInt(60_000),
  /** replica scrubbing (§7.4) */
  SCRUB_INTERVAL_MS: envInt(60_000),
  SCRUB_BATCH: envInt(25),
  SCRUB_MAX_AGE_HOURS: envInt(168),
  /** HOT / WARM / COLD classification and adaptive replication (§9.3, §9.4) */
  CLASSIFY_INTERVAL_MS: envInt(30_000),
  HOT_READS_24H: envInt(20),
  HOT_READS_7D: envInt(100),
  HOT_DEMOTE_HOURS: envInt(48),
  COLD_AFTER_DAYS: envInt(14),
  HOT_REPLICAS: envInt(3),
  /** ransomware / anomaly detection (§9.5) */
  ANOMALY_INTERVAL_MS: envInt(10_000),
  ANOMALY_DELETE_BURST: envInt(50),
  ANOMALY_DELETE_SHARE_PCT: envInt(30),
  ANOMALY_OVERWRITE_BURST: envInt(50),
  ANOMALY_ENTROPY_SHIFTS: envInt(5),
  ANOMALY_EXTENSION_CHURN: envInt(10),
  /** pre-attack versions stay immutable (and unpurgeable) this long */
  PROTECT_DAYS: envInt(30),
  LOG_LEVEL: z.string().default('info'),
});
export type Config = z.infer<typeof schema>;
export const loadConfig = (): Config => parseEnv(schema);
