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

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
