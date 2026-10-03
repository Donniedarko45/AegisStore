import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  NodeMetrics,
  NodeStatus,
  Permission,
  ReplicaState,
  StorageClass,
  UserRole,
  VersionState,
} from '@aegis/shared';

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const bytes = (name: string) => bigint(name, { mode: 'number' });

// ---------------------------------------------------------------- identity & access
export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name'),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<UserRole>().notNull().default('MEMBER'),
  status: text('status').notNull().default('ACTIVE'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** first chars of the key, shown in the UI and used for lookup */
    prefix: text('prefix').notNull().unique(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`ARRAY['read','write']::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('api_keys_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------- buckets & objects
export const buckets = pgTable(
  'buckets',
  {
    id: id(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id').notNull().references(() => users.id),
    versioningEnabled: boolean('versioning_enabled').notNull().default(false),
    publicRead: boolean('public_read').notNull().default(false),
    /** set by the anomaly engine (Phase 10) */
    protectedMode: boolean('protected_mode').notNull().default(false),
    /** opt-in: lock the bucket (protected mode) automatically when a HIGH+ attack is detected */
    autoLock: boolean('auto_lock').notNull().default(false),
    defaultReplicas: integer('default_replicas').notNull().default(2),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  // names are unique among live buckets, so a deleted bucket's name can be reused
  (t) => [uniqueIndex('buckets_name_live_uq').on(t.name).where(sql`${t.deletedAt} IS NULL`)],
);

export const bucketGrants = pgTable(
  'bucket_grants',
  {
    id: id(),
    bucketId: uuid('bucket_id').notNull().references(() => buckets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission').$type<Permission>().notNull(),
    grantedBy: uuid('granted_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique('bucket_grants_bucket_user_uq').on(t.bucketId, t.userId)],
);

export const objects = pgTable(
  'objects',
  {
    id: id(),
    bucketId: uuid('bucket_id').notNull().references(() => buckets.id),
    key: text('key').notNull(),
    /** newest non-delete-marker ACTIVE version, or NULL. (No FK: avoids a circular dependency.) */
    currentVersionId: uuid('current_version_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    /** last time the object qualified as HOT (demotion hysteresis, §9.3) */
    lastHotAt: timestamp('last_hot_at', { withTimezone: true }),
    classChangedAt: timestamp('class_changed_at', { withTimezone: true }),
  },
  (t) => [
    unique('objects_bucket_key_uq').on(t.bucketId, t.key),
    index('objects_bucket_key_prefix_idx').on(t.bucketId, sql`${t.key} text_pattern_ops`),
  ],
);

export const objectVersions = pgTable(
  'object_versions',
  {
    id: id(),
    objectId: uuid('object_id').notNull().references(() => objects.id),
    versionNo: integer('version_no').notNull(),
    size: bytes('size').notNull().default(0),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    sha256: text('sha256'),
    blobId: uuid('blob_id'),
    isDeleteMarker: boolean('is_delete_marker').notNull().default(false),
    state: text('state').$type<VersionState>().notNull().default('PENDING'),
    storageClass: text('storage_class').$type<StorageClass>().notNull().default('WARM'),
    targetReplicas: integer('target_replicas').notNull().default(2),
    /** Shannon entropy (bits/byte) of the first 64 KB: ~8 means random or encrypted */
    entropy: real('entropy'),
    isProtected: boolean('is_protected').notNull().default(false),
    protectedUntil: timestamp('protected_until', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
  },
  (t) => [
    unique('object_versions_object_no_uq').on(t.objectId, t.versionNo),
    index('object_versions_state_purge_idx').on(t.state, t.purgeAfter),
    index('object_versions_object_idx').on(t.objectId),
  ],
);

/** Reads per object per hour: the input to HOT / WARM / COLD classification (§9.3). */
export const objectAccess = pgTable(
  'object_access',
  {
    objectId: uuid('object_id').notNull().references(() => objects.id, { onDelete: 'cascade' }),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    reads: integer('reads').notNull().default(0),
    bytes: bytes('bytes').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.objectId, t.hour] }), index('object_access_hour_idx').on(t.hour)],
);

export const storageNodes = pgTable('storage_nodes', {
  id: id(),
  name: text('name').notNull().unique(),
  baseUrl: text('base_url').notNull(),
  status: text('status').$type<NodeStatus>().notNull().default('HEALTHY'),
  riskScore: real('risk_score').notNull().default(0),
  capacityBytes: bytes('capacity_bytes').notNull().default(0),
  usedBytes: bytes('used_bytes').notNull().default(0),
  blobCount: integer('blob_count').notNull().default(0),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  /** consecutive heartbeats since coming back from OFFLINE */
  probationBeats: integer('probation_beats').notNull().default(0),
  lastMetrics: jsonb('last_metrics').$type<NodeMetrics>(),
  vnodeCount: integer('vnode_count').notNull().default(128),
  /** administrator asked to evacuate this node; survives OFFLINE -> back online */
  draining: boolean('draining').notNull().default(false),
  /** latest risk explanation: signals, contributions, disk ETA (see @aegis/shared risk.ts) */
  riskFactors: jsonb('risk_factors').$type<Record<string, unknown>>(),
  /** smoothed (EWMA) inputs carried between scorer ticks */
  riskState: jsonb('risk_state').$type<Record<string, number>>(),
  riskUpdatedAt: timestamp('risk_updated_at', { withTimezone: true }),
  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
  registeredAt: createdAt(),
});

export const replicas = pgTable(
  'replicas',
  {
    id: id(),
    versionId: uuid('version_id').notNull().references(() => objectVersions.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id').notNull().references(() => storageNodes.id),
    blobPath: text('blob_path').notNull(),
    sha256: text('sha256'),
    state: text('state').$type<ReplicaState>().notNull().default('PENDING'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('replicas_version_node_uq').on(t.versionId, t.nodeId),
    index('replicas_node_idx').on(t.nodeId),
    index('replicas_state_idx').on(t.state),
  ],
);

export const nodeMetrics = pgTable(
  'node_metrics',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    nodeId: uuid('node_id').notNull().references(() => storageNodes.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    cpuPct: real('cpu_pct').notNull(),
    memPct: real('mem_pct').notNull(),
    diskUsedPct: real('disk_used_pct').notNull(),
    latencyMsP50: real('latency_ms_p50').notNull(),
    latencyMsP95: real('latency_ms_p95').notNull(),
    errorRate: real('error_rate').notNull(),
    blobCount: integer('blob_count').notNull(),
    probeMs: real('probe_ms').notNull().default(0),
    riskScore: real('risk_score').notNull().default(0),
    uptimeSec: real('uptime_sec').notNull().default(0),
  },
  (t) => [index('node_metrics_node_ts_idx').on(t.nodeId, t.ts)],
);

// ---------------------------------------------------------------- security (§9.5, §9.6)
export const securityEvents = pgTable(
  'security_events',
  {
    id: id(),
    /** RANSOMWARE | MASS_DELETE | ANOMALY */
    kind: text('kind').notNull(),
    /** LOW | MEDIUM | HIGH | CRITICAL */
    severity: text('severity').notNull(),
    /** OPEN | ACKNOWLEDGED | RESOLVED | FALSE_POSITIVE */
    status: text('status').notNull().default('OPEN'),
    bucketId: uuid('bucket_id').references(() => buckets.id),
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    actorType: text('actor_type'),
    /** [{ signal, value, threshold, severity, detail }] */
    signals: jsonb('signals').$type<Record<string, unknown>[]>().notNull().default([]),
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    attackStart: timestamp('attack_start', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    protectedVersions: integer('protected_versions').notNull().default(0),
    /** the bucket was locked (protected mode) because of this event */
    contained: boolean('contained').notNull().default(false),
    notes: text('notes'),
    recovery: jsonb('recovery').$type<Record<string, unknown>>(),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('security_events_status_idx').on(t.status, t.createdAt), index('security_events_bucket_actor_idx').on(t.bucketId, t.actorId)],
);

// ---------------------------------------------------------------- background jobs
/**
 * Durable work queue in Postgres (Redis stays disposable). Workers claim rows with
 * FOR UPDATE SKIP LOCKED; `dedupe_key` is unique among QUEUED/RUNNING jobs so the reconciler can
 * re-derive work every tick without enqueuing duplicates.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    /** REPAIR_REPLICA | TRIM_REPLICA | VERIFY_REPLICA */
    type: text('type').notNull(),
    /** QUEUED | RUNNING | DONE | FAILED | CANCELLED */
    status: text('status').notNull().default('QUEUED'),
    /** lower runs first */
    priority: integer('priority').notNull().default(100),
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>(),
    reason: text('reason'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    bytes: bytes('bytes').notNull().default(0),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('jobs_dedupe_active_uq').on(t.dedupeKey).where(sql`${t.status} IN ('QUEUED', 'RUNNING')`),
    index('jobs_claim_idx').on(t.status, t.priority, t.runAfter),
    index('jobs_created_idx').on(t.createdAt),
  ],
);

// ---------------------------------------------------------------- ops
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    /** monotonically increasing; defines the hash-chain order */
    seq: bigserial('seq', { mode: 'number' }).notNull().unique(),
    actorId: uuid('actor_id'),
    actorType: text('actor_type').notNull(), // USER | API_KEY | SYSTEM | ANONYMOUS
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    requestId: text('request_id'),
    prevHash: text('prev_hash').notNull(),
    rowHash: text('row_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_created_idx').on(t.createdAt),
    index('audit_logs_actor_idx').on(t.actorId),
    index('audit_logs_action_idx').on(t.action),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
