import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from './plugins/auth';

describe('isAllowedOrigin (CSRF defence)', () => {
  it('allows requests without Origin (non-browser clients)', () => {
    expect(isAllowedOrigin(undefined, 'localhost:8080', [])).toBe(true);
  });
  it('allows same-origin browser requests', () => {
    expect(isAllowedOrigin('http://localhost:8080', 'localhost:8080', [])).toBe(true);
    expect(isAllowedOrigin('https://store.example.com', 'store.example.com', [])).toBe(true);
  });
  it('blocks a different site, port or scheme-confusable host', () => {
    expect(isAllowedOrigin('https://evil.example', 'store.example.com', [])).toBe(false);
    expect(isAllowedOrigin('http://localhost:9999', 'localhost:8080', [])).toBe(false);
    expect(isAllowedOrigin('http://store.example.com.evil.io', 'store.example.com', [])).toBe(false);
  });
  it('allows explicitly configured origins', () => {
    expect(isAllowedOrigin('https://app.example.com', 'api.internal', ['https://app.example.com'])).toBe(true);
  });
  it('rejects garbage origins', () => {
    expect(isAllowedOrigin('null', 'localhost:8080', [])).toBe(false);
    expect(isAllowedOrigin('not a url', 'localhost:8080', [])).toBe(false);
  });
});
