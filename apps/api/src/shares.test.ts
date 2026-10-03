import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from './modules/shares';

const secret = 'a-very-secret-signing-key';
const id = '0b6f3f9e-2d1c-4a5e-9f00-123456789abc';
const exp = new Date('2030-01-01T00:00:00Z');

describe('share link tokens', () => {
  it('verifies a token it signed', () => {
    expect(verifyToken(secret, signToken(secret, id, exp), exp)).toBe(true);
  });
  it('rejects a token signed with another secret (rotation invalidates links)', () => {
    expect(verifyToken(secret, signToken('another-secret-key-xx', id, exp), exp)).toBe(false);
  });
  it('rejects a token whose expiry was changed', () => {
    expect(verifyToken(secret, signToken(secret, id, exp), new Date('2031-01-01T00:00:00Z'))).toBe(false);
  });
  it('rejects a token moved to another link id', () => {
    const mac = signToken(secret, id, exp).split('.')[1];
    expect(verifyToken(secret, `11111111-2222-3333-4444-555555555555.${mac}`, exp)).toBe(false);
  });
  it('rejects garbage', () => {
    expect(verifyToken(secret, 'nonsense', exp)).toBe(false);
  });
});
