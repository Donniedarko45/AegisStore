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

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.requestId);
  }
  return data as T;
}
const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

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

/** Upload with progress (fetch cannot report upload progress, XHR can). */
export function uploadObject(
  bucket: string,
  key: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ key: string; versionNo: number; size: number; sha256: string; replicas: { node: string; path: string }[] }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', objectUrl(bucket, key));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
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

export interface ObjectList {
  items: ObjectSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
}
export interface VersionDto {
  versionId: string;
  versionNo: number;
  size: number;
  sha256: string | null;
  state: string;
  isDeleteMarker: boolean;
  isCurrent: boolean;
  isProtected: boolean;
  createdAt: string;
  createdBy: string | null;
}
export interface ObjectDetails {
  key: string;
  bucket: string;
  current: {
    versionId: string;
    versionNo: number;
    size: number;
    contentType: string;
    sha256: string;
    storageClass: 'HOT' | 'WARM' | 'COLD';
    targetReplicas: number;
    createdAt: string;
    integrity: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
  } | null;
  replicas: ReplicaDto[];
  versions: VersionDto[];
}
export interface DashboardSummary {
  storage: { capacityBytes: number; usedBytes: number; usedPct: number };
  logical: { bucketCount: number; objectCount: number; bytes: number };
  nodes: { total: number; healthy: number; atRisk: number; byStatus: Record<string, number> };
  perNode: { id: string; name: string; status: string; usedBytes: number; capacityBytes: number; usedPct: number; blobCount: number }[];
  recentActivity: { id: string; action: string; actor: string | null; resourceType: string | null; metadata: Record<string, unknown>; createdAt: string }[];
}
export interface NodeDetail {
  node: NodeDto;
  replicaCount: number;
  history: { ts: string; cpuPct: number; memPct: number; diskUsedPct: number; latencyMsP50: number; latencyMsP95: number; errorRate: number }[];
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
