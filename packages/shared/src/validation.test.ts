import { describe, expect, it } from 'vitest';
import { bucketNameSchema, createApiKeySchema, registerSchema } from './validation';

describe('bucketNameSchema', () => {
  it.each(['research-data', 'abc', 'a1-b2-c3', 'x'.repeat(63)])('accepts %s', (n) => {
    expect(bucketNameSchema.safeParse(n).success).toBe(true);
  });
  it.each(['ab', 'Bad_Name', '-lead', 'trail-', 'UPPER', 'has space', 'x'.repeat(64), 'dots.not.ok'])('rejects %s', (n) => {
    expect(bucketNameSchema.safeParse(n).success).toBe(false);
  });
});

describe('registerSchema', () => {
  it('normalises the email and enforces password length', () => {
    expect(registerSchema.parse({ email: '  Alice@Example.COM ', password: 'longenough' }).email).toBe('alice@example.com');
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
    expect(registerSchema.safeParse({ email: 'not-an-email', password: 'longenough' }).success).toBe(false);
  });
});

describe('createApiKeySchema', () => {
  it('defaults to read+write and rejects unknown scopes', () => {
    expect(createApiKeySchema.parse({ name: 'k' }).scopes).toEqual(['read', 'write']);
    expect(createApiKeySchema.safeParse({ name: 'k', scopes: ['root'] }).success).toBe(false);
  });
});
