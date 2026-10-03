import { AppError } from '@aegis/shared';
import type { z } from 'zod';

/** Validate untrusted input with zod and surface a clean 400. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
    throw AppError.validation(msg, r.error.issues);
  }
  return r.data;
}

/** drizzle's db.execute() returns a pg QueryResult; this unwraps the rows with a type. */
export function rowsOf<T>(res: unknown): T[] {
  return (res as { rows: T[] }).rows;
}

/**
 * Dates from the ORM are Date objects, but raw `db.execute()` rows carry Postgres timestamp
 * strings ("2026-10-03 08:41:07.12+00"), which V8 parses correctly. Accept both.
 */
export const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
