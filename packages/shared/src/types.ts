import type { IntegrityStatus, NodeStatus, Permission, StorageClass, UserRole } from './constants';

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
}
