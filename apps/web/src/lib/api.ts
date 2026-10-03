import type { BucketDto, NodeDto, ObjectSummaryDto, ReplicaDto, UserDto } from '@aegis/shared/web';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.requestId);
  }
  return data as T;
}

export const http = {
  get: <T>(u: string) => request<T>('GET', u),
  post: <T>(u: string, b?: unknown) => request<T>('POST', u, b ?? {}),
  put: <T>(u: string, b?: unknown) => request<T>('PUT', u, b ?? {}),
  patch: <T>(u: string, b?: unknown) => request<T>('PATCH', u, b ?? {}),
  del: <T>(u: string) => request<T>('DELETE', u),
};

const q = encodeURIComponent;
export const objectUrl = (bucket: string, key: string, versionId?: string) =>
  `/api/buckets/${q(bucket)}/object?key=${q(key)}${versionId ? `&versionId=${q(versionId)}` : ''}`;

export interface UploadResult {
  key: string;
  versionNo: number;
  size: number;
  sha256: string;
  replicas: { node: string; path: string }[];
}

/** Upload with progress + cancellation (fetch cannot report upload progress, XHR can). */
export function uploadObject(bucket: string, key: string, file: File, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', objectUrl(bucket, key));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      const data = safeJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const e = data?.error;
      reject(new ApiError(xhr.status, e?.code ?? 'ERROR', e?.message ?? `Upload failed (${xhr.status})`, e?.requestId));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Network error while uploading'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload cancelled'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

// ------------------------------------------------------------------------------------- types
export type { BucketDto, NodeDto, ObjectSummaryDto, ReplicaDto, UserDto };
export type Range = '1h' | '6h' | '24h' | '7d' | '30d';

export interface ObjectList {
  items: ObjectSummaryDto[];
  prefixes: { prefix: string; objects: number; bytes: number }[];
  total: number;
  page: number;
  pageSize: number;
}
export interface VersionDto {
  versionId: string;
  versionNo: number;
  size: number;
  sha256: string | null;
  state: 'PENDING' | 'ACTIVE' | 'DELETED' | 'PURGED';
  isDeleteMarker: boolean;
  isCurrent: boolean;
  isProtected: boolean;
  createdAt: string;
  deletedAt: string | null;
  purgeAfter: string | null;
  createdBy: string | null;
}
export type Integrity = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
export interface ObjectDetails {
  key: string;
  bucket: string;
  placement: { key: string; ringPos: number; ringOrder: string[] } | null;
  current: {
    versionId: string;
    versionNo: number;
    size: number;
    contentType: string;
    sha256: string;
    storageClass: 'HOT' | 'WARM' | 'COLD';
    targetReplicas: number;
    createdAt: string;
    integrity: Integrity;
  } | null;
  replicas: ReplicaDto[];
  versions: VersionDto[];
}
export interface DeletedObject {
  key: string;
  versionId: string;
  versionNo: number;
  size: number;
  contentType: string;
  sha256: string;
  deletedAt: string | null;
  purgeAfter: string | null;
}
export interface DashboardSummary {
  storage: { capacityBytes: number; usedBytes: number; usedPct: number };
  logical: { bucketCount: number; objectCount: number; bytes: number };
  nodes: { total: number; healthy: number; atRisk: number; byStatus: Record<string, number> };
  perNode: { id: string; name: string; status: string; usedBytes: number; capacityBytes: number; usedPct: number; blobCount: number }[];
  recentActivity: { id: string; action: string; actor: string | null; resourceType: string | null; metadata: Record<string, unknown>; createdAt: string }[];
}
export interface ActivityPoint {
  t: string;
  uploads: number;
  uploadBytes: number;
  downloads: number;
  downloadBytes: number;
  deletes: number;
  integrityFailures: number;
}
export interface AnalyticsOverview {
  range: Range;
  step: string;
  totals: { uploads: number; uploadBytes: number; downloads: number; downloadBytes: number; deletes: number; integrityFailures: number };
  activity: ActivityPoint[];
  storage: { t: string; bytes: number; objects: number }[];
  byType: { type: string; objects: number; bytes: number }[];
  byBucket: { bucket: string; objects: number; bytes: number }[];
  integrity: { healthy: number; degraded: number; unavailable: number };
  sizeHistogram: { bucket: string; objects: number }[];
  topDownloads: { bucket: string; key: string; downloads: number; bytes: number }[];
}
export interface RingData {
  vnodesPerNode: number;
  replicationFactor: number;
  nodes: { id: string; name: string; status: string; sharePct: number }[];
  points: { pos: number; node: string }[];
}
export type MetricRow = { t: string } & Record<string, number | string>;
export interface NodeMetricsSeries {
  range: Range;
  step: string;
  nodes: string[];
  cpu: MetricRow[];
  mem: MetricRow[];
  disk: MetricRow[];
  latencyP50: MetricRow[];
  latencyP95: MetricRow[];
  errorRate: MetricRow[];
  probe: MetricRow[];
}
export interface UptimeData {
  range: string;
  nodes: {
    id: string;
    name: string;
    status: string;
    uptimePct: number | null;
    bars: { t: string; upPct: number | null }[];
    incidents: { start: string; end: string | null; durationSec: number }[];
  }[];
}
export interface NodeDetail {
  node: NodeDto;
  replicaCount: number;
  history: { ts: string; cpuPct: number; memPct: number; diskUsedPct: number; latencyMsP50: number; latencyMsP95: number; errorRate: number; probeMs: number }[];
}
export interface AuditItem {
  id: string;
  seq: number;
  action: string;
  actorType: string;
  actor: string | null;
  resourceType: string | null;
  resourceId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}
export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface GrantDto {
  userId: string;
  email: string;
  name: string | null;
  permission: 'READ' | 'WRITE' | 'ADMIN';
  createdAt: string;
}
export interface SessionDto {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: 'ADMIN' | 'MEMBER';
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
  lastLoginAt: string | null;
  buckets: number;
  objects: number;
  bytes: number;
  apiKeys: number;
  sessions: number;
}
export interface SystemInfo {
  version: string;
  startedAt: string;
  components: { api: string; database: string; postgresVersion: string | null; redis: 'up' | 'down' };
  config: { replicationFactor: number; vnodesPerNode: number; offlineAfterMs: number; probationBeats: number; maxUploadBytes: number; verifyBufferMaxBytes: number; retentionHours: number };
}
