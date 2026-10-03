import { createHash } from 'node:crypto';
import { desc, sql } from 'drizzle-orm';
import { auditLogs } from './schema';
import type { Db } from './index';

const GENESIS = '0'.repeat(64);
const AUDIT_LOCK = 7243001;

export interface AuditRow {
  actorId: string | null;
  actorType: string;
  actorLabel?: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Deterministic JSON: object keys sorted recursively. Postgres `jsonb` does not preserve key
 * order, so hashing the in-memory object would never match what verification reads back.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** Canonical form that is hashed; the field order is part of the on-disk format. */
function rowHash(
  prevHash: string,
  r: Pick<AuditRow, 'actorId' | 'actorType' | 'action' | 'resourceType' | 'resourceId' | 'metadata' | 'requestId'> & { createdAt: Date },
): string {
  return createHash('sha256')
    .update(
      canonicalJson([prevHash, r.actorId, r.actorType, r.action, r.resourceType, r.resourceId, r.metadata, r.requestId, r.createdAt.toISOString()]),
    )
    .digest('hex');
}

/** Append one entry to the tamper-evident audit chain (each row hashes the previous one). */
export async function appendAudit(db: Db, row: AuditRow): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK})`);
    const [last] = await tx.select({ h: auditLogs.rowHash }).from(auditLogs).orderBy(desc(auditLogs.seq)).limit(1);
    const prevHash = last?.h ?? GENESIS;
    const createdAt = new Date();
    await tx.insert(auditLogs).values({
      actorId: row.actorId,
      actorType: row.actorType,
      actorLabel: row.actorLabel ?? null,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      metadata: row.metadata,
      requestId: row.requestId,
      ip: row.ip ?? null,
      userAgent: row.userAgent ?? null,
      prevHash,
      rowHash: rowHash(prevHash, { ...row, createdAt }),
      createdAt,
    });
  });
}

/** Recompute the whole chain; returns the first broken sequence number, if any. */
export async function verifyAuditChain(db: Db): Promise<{ ok: boolean; checked: number; brokenAtSeq?: number }> {
  const rows = await db.select().from(auditLogs).orderBy(auditLogs.seq);
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prevHash !== prev || r.rowHash !== rowHash(prev, r)) {
      return { ok: false, checked: rows.length, brokenAtSeq: r.seq };
    }
    prev = r.rowHash;
  }
  return { ok: true, checked: rows.length };
}
