export const USER_ROLES = ['ADMIN', 'MEMBER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Hierarchical bucket permission: READ < WRITE < ADMIN */
export const PERMISSIONS = ['READ', 'WRITE', 'ADMIN'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const NODE_STATUSES = ['HEALTHY', 'WARNING', 'HIGH_RISK', 'OFFLINE', 'DRAINING'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const VERSION_STATES = ['PENDING', 'ACTIVE', 'DELETED', 'PURGED'] as const;
export type VersionState = (typeof VERSION_STATES)[number];

export const REPLICA_STATES = ['PENDING', 'HEALTHY', 'CORRUPT', 'MISSING', 'DRAINING'] as const;
export type ReplicaState = (typeof REPLICA_STATES)[number];

export const STORAGE_CLASSES = ['HOT', 'WARM', 'COLD'] as const;
export type StorageClass = (typeof STORAGE_CLASSES)[number];

/** Derived per object: how many usable replicas exist vs the target */
export const INTEGRITY_STATUSES = ['HEALTHY', 'DEGRADED', 'UNAVAILABLE'] as const;
export type IntegrityStatus = (typeof INTEGRITY_STATUSES)[number];

export const API_KEY_SCOPES = ['read', 'write', 'admin'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const DEFAULTS = {
  replicationFactor: 2,
  vnodesPerNode: 128,
  heartbeatIntervalMs: 5000,
  offlineAfterMs: 15000,
  probationBeats: 3,
  maxUploadBytes: 100 * 1024 * 1024,
  verifyBufferMaxBytes: 16 * 1024 * 1024,
  retentionHours: 24,
} as const;

export const API_KEY_PREFIX = 'aegis';
export const SESSION_COOKIE = 'aegis_session';
