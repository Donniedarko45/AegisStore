import type { IntegrityStatus, NodeStatus, Permission, StorageClass, UserRole } from './constants';
import type { RiskFactor } from './risk';

/** Metrics a storage node reports in each heartbeat */
export interface NodeMetrics {
  cpuPct: number;
  memPct: number;
  diskUsedBytes: number;
  diskCapacityBytes: number;
  diskUsedPct: number;
  latencyMsP50: number;
  latencyMsP95: number;
  errorRate: number;
  blobCount: number;
  uptimeSec: number;
  /** write+fsync+read of a 4 KB probe file, measured every heartbeat (always present, even when idle) */
  probeMs?: number;
}

export interface HeartbeatBody {
  name: string;
  baseUrl: string;
  metrics: NodeMetrics;
}

export interface UserDto {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  createdAt: string;
}

export interface BucketDto {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail?: string;
  versioningEnabled: boolean;
  publicRead: boolean;
  protectedMode: boolean;
  autoLock: boolean;
  createdAt: string;
  objectCount?: number;
  totalBytes?: number;
  /** caller's effective permission */
  permission?: Permission | 'OWNER';
}

export interface ReplicaDto {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeStatus: NodeStatus;
  state: string;
  blobPath: string;
  sha256: string | null;
  checksumMatch: boolean;
  lastVerifiedAt: string | null;
}

export interface ObjectSummaryDto {
  key: string;
  versionId: string;
  versionNo: number;
  size: number;
  contentType: string;
  sha256: string;
  storageClass: StorageClass;
  integrity: IntegrityStatus;
  availableReplicas: number;
  targetReplicas: number;
  createdAt: string;
}

export interface NodeDto {
  id: string;
  name: string;
  baseUrl: string;
  status: NodeStatus;
  riskScore: number;
  capacityBytes: number;
  usedBytes: number;
  blobCount: number;
  lastHeartbeatAt: string | null;
  ringSharePct: number;
  metrics: NodeMetrics | null;
  draining: boolean;
  statusChangedAt: string | null;
  risk: NodeRiskDto | null;
}

/** Why a node has the risk score it has (written by the worker's risk scorer). */
export interface NodeRiskDto {
  signals: Record<RiskFactor, number>;
  contributions: Record<RiskFactor, number>;
  top: RiskFactor | null;
  diskFullEtaHours: number | null;
  inputs: Record<string, number>;
  updatedAt: string | null;
}
