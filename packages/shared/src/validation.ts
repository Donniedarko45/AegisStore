import { z } from 'zod';
import { API_KEY_SCOPES, PERMISSIONS } from './constants';

/** DNS-safe bucket name: 3-63 chars, lowercase letters, digits, hyphens, no leading/trailing hyphen */
export const bucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/, 'Use lowercase letters, numbers and hyphens (3-63 chars)');

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(200);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100).optional(),
});
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });

export const createBucketSchema = z.object({
  name: bucketNameSchema,
  versioningEnabled: z.boolean().default(false),
  publicRead: z.boolean().default(false),
});
export const updateBucketSchema = z.object({
  versioningEnabled: z.boolean().optional(),
  publicRead: z.boolean().optional(),
});

export const setGrantSchema = z.object({
  email: emailSchema,
  permission: z.enum(PERMISSIONS),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).default(['read', 'write']),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export const listObjectsQuerySchema = z.object({
  prefix: z.string().max(1024).optional(),
  q: z.string().max(200).optional(),
  integrity: z.enum(['HEALTHY', 'DEGRADED', 'UNAVAILABLE']).optional(),
  class: z.enum(['HOT', 'WARM', 'COLD']).optional(),
  sort: z.enum(['key', 'size', 'createdAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

/** Object keys: 1-1024 bytes, no control chars, no path traversal segments, no leading slash */
export function validateObjectKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0) throw new Error('Object key is required');
  if (Buffer.byteLength(key, 'utf8') > 1024) throw new Error('Object key must be at most 1024 bytes');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new Error('Object key contains control characters');
  if (key.startsWith('/')) throw new Error('Object key must not start with "/"');
  if (key.split('/').some((seg) => seg === '..' || seg === '.'))
    throw new Error('Object key must not contain "." or ".." path segments');
  return key;
}
