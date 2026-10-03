import { sql, type SQL } from '@aegis/db';

/** SQL fragment: ids of live buckets the user may see (admins see all). */
export function visibleBucketIds(user: { id: string; role: string }): SQL {
  const isAdmin = user.role === 'ADMIN';
  return sql`(
    SELECT b.id FROM buckets b
    WHERE b.deleted_at IS NULL
      AND (${isAdmin} OR b.owner_id = ${user.id}
           OR EXISTS (SELECT 1 FROM bucket_grants g WHERE g.bucket_id = b.id AND g.user_id = ${user.id})))`;
}

export const RANGES = {
  '1h': { interval: '1 hour', step: '1 minute' },
  '6h': { interval: '6 hours', step: '5 minutes' },
  '24h': { interval: '24 hours', step: '30 minutes' },
  '7d': { interval: '7 days', step: '4 hours' },
  '30d': { interval: '30 days', step: '1 day' },
} as const;
export type RangeKey = keyof typeof RANGES;
export const rangeOf = (r: unknown): RangeKey => (typeof r === 'string' && r in RANGES ? (r as RangeKey) : '24h');
