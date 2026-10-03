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
  replicas: { node: string; path: string; fallbackFor?: string }[];
  parts?: number;
}

/** Files above this size go through multipart upload (parallel, resumable parts). */
export const MULTIPART_THRESHOLD = 64 * 1024 * 1024;

function putWithProgress(url: string, body: Blob, contentType: string, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const data = safeJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const e = data?.error;
      reject(new ApiError(xhr.status, e?.code ?? 'ERROR', e?.message ?? `Upload failed (${xhr.status})`, e?.requestId));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Network error while uploading'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload cancelled'));
    if (signal?.aborted) return xhr.abort();
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(body);
  });
}

/**
 * Multipart upload: parts go up three at a time, each retried up to 3 times (a dropped
 * connection costs one part, not the whole file), then the server assembles and verifies them.
 */
export async function uploadMultipart(bucket: string, key: string, file: File, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  const base = `/api/buckets/${q(bucket)}/multipart`;
  const init = await http.post<{ uploadId: string; partSize: number }>(`${base}?key=${q(key)}`, { size: file.size, contentType: file.type || 'application/octet-stream' });
  const partSize = init.partSize;
  const count = Math.max(1, Math.ceil(file.size / partSize));
  const loaded = new Array<number>(count).fill(0);
  const report = () => onProgress(loaded.reduce((a, b) => a + b, 0), file.size);
  const parts: { partNo: number; sha256: string }[] = [];
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(3, count) }, async () => {
        while (next < count) {
          const i = next++;
          const blob = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
          for (let attempt = 1; ; attempt++) {
            try {
              const r = (await putWithProgress(`${base}/${init.uploadId}/parts/${i + 1}`, blob, 'application/octet-stream', (l) => ((loaded[i] = l), report()), signal)) as { sha256: string };
              parts[i] = { partNo: i + 1, sha256: r.sha256 };
              break;
            } catch (e) {
              if (signal?.aborted || attempt >= 3 || (e instanceof ApiError && e.status >= 400 && e.status < 500)) throw e;
              loaded[i] = 0;
              await new Promise((r) => setTimeout(r, 500 * attempt));
            }
          }
        }
      }),
    );
    return await http.post<UploadResult>(`${base}/${init.uploadId}/complete`, { parts });
  } catch (e) {
    void http.del(`${base}/${init.uploadId}`).catch(() => undefined);
    throw e;
  }
}

/** Upload with progress + cancellation (fetch cannot report upload progress, XHR can). */
export function uploadSingle(bucket: string, key: string, file: File, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<UploadResult> {
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

/** Upload a file: one streamed request, or multipart above MULTIPART_THRESHOLD. */
export function uploadObject(bucket: string, key: string, file: File, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return file.size > MULTIPART_THRESHOLD ? uploadMultipart(bucket, key, file, onProgress, signal) : uploadSingle(bucket, key, file, onProgress, signal);
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
  protectedUntil: string | null;
  entropy: number | null;
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
  access: { reads24h: number; reads7d: number; lastAccessedAt: string | null; classChangedAt: string | null; hourly: { t: string; reads: number }[] };
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
  byClass: { class: 'HOT' | 'WARM' | 'COLD'; objects: number; bytes: number; reads24h: number; replicas: number }[];
  classChanges: { t: string; promoted: number; demoted: number }[];
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
export interface RiskSeries {
  range: Range;
  step: string;
  nodes: string[];
  series: MetricRow[];
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

// ------------------------------------------------------------------------- self-healing
export interface HealingSummary {
  reconciler: {
    at: string;
    scanned: number;
    underReplicated: number;
    overReplicated: number;
    cannotReachTarget: number;
    noSource: number;
    waitingGrace: number;
    enqueued: number;
    updatedAt: string | null;
  } | null;
  queue: { queued: number; running: number; done24h: number; failed24h: number; repaired24h: number; trimmed24h: number; verified24h: number; bytesHealed24h: number };
  scrub: { replicas: number; verified7d: number; oldestVerification: string | null };
  integrity: { corrupt: number; missing: number };
}
export type JobType = 'REPAIR_REPLICA' | 'TRIM_REPLICA' | 'VERIFY_REPLICA';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
export interface HealingJob {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  reason: string | null;
  bucket: string | null;
  key: string | null;
  node: string | null;
  result: Record<string, unknown> | null;
  attempts: number;
  lastError: string | null;
  bytes: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface HealingActivity {
  range: Range;
  step: string;
  series: { t: string; repaired: number; trimmed: number; verified: number; failed: number; bytes: number }[];
}

// ----------------------------------------------------------------------------- security
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type EventStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'FALSE_POSITIVE';
export interface SecuritySignal {
  signal: 'DELETE_BURST' | 'OVERWRITE_BURST' | 'ENTROPY_SHIFT' | 'EXTENSION_CHURN' | 'RATE_ANOMALY';
  value: number;
  threshold: number;
  severity: Severity;
  detail: string;
}
export interface SecurityEvent {
  id: string;
  kind: 'RANSOMWARE' | 'MASS_DELETE' | 'ANOMALY';
  severity: Severity;
  status: EventStatus;
  bucket: string | null;
  actor: string | null;
  actorId: string | null;
  actorType: string | null;
  signals: SecuritySignal[];
  counts: Record<string, number>;
  attackStart: string;
  lastSeenAt: string;
  protectedVersions: number;
  contained: boolean;
  notes: string | null;
  recovery: { restored: number; removed: number; unchanged: number; unrecoverable: number; failed: string[]; at: string; by: string } | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface SecuritySummary {
  open: number;
  bySeverity: Record<Severity, number>;
  lockedBuckets: string[];
  protectedVersions: number;
  daily: { day: string; severity: Severity; n: number }[];
}
export interface SecurityEventDetail {
  event: SecurityEvent;
  timeline: { t: string; uploads: number; deletes: number; suspicious: number }[];
  actions: { action: string; key: string; at: string; entropy: number | null; prev: number | null }[];
}
export interface RecoveryPlan {
  bucket: string;
  attackStart: string;
  summary: { restore: number; remove: number; unchanged: number; unrecoverable: number };
  items: { key: string; action: 'restore' | 'remove' | 'unchanged' | 'unrecoverable'; currentVersionNo: number | null; cleanVersionNo: number | null; currentEntropy: number | null; cleanEntropy: number | null; size: number | null }[];
}

// ----------------------------------------------------------------------------- sharing
export interface ShareLink {
  id: string;
  createdBy: string | null;
  versionNo: number | null;
  createdAt: string;
  expiresAt: string;
  maxDownloads: number | null;
  downloads: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'USED_UP';
}

// ------------------------------------------------------------------------ simulation lab
export interface ChaosState {
  offline: boolean;
  latencyMs: number;
  errorRate: number;
  diskFillPct: number;
}
export type RunKind = 'CHAOS' | 'CORRUPT' | 'TRAFFIC' | 'RANSOMWARE';
export interface SimRun {
  id: string;
  kind: RunKind;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  params: Record<string, unknown>;
  scope: { nodes?: string[]; buckets?: string[] };
  summary: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
}
export interface SimulationState {
  nodes: { id: string; name: string; status: string; riskScore: number; reachable: boolean; chaos: ChaosState | null }[];
  runs: SimRun[];
}
export interface SimRunDetail {
  run: SimRun;
  counts: { uploads: number; downloads: number; deletes: number };
  timeline: { action: string; actor: string | null; metadata: Record<string, unknown>; at: string }[];
}
