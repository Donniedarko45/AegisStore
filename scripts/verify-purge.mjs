#!/usr/bin/env node
/**
 * Verifies the retention purge end to end. Needs a stack started with RETENTION_HOURS=0 (and a
 * short PURGE_INTERVAL_MS on the worker), plus RUNTIME_DIR pointing at the node data folders:
 *
 *   RETENTION_HOURS=0 PURGE_INTERVAL_MS=3000 node scripts/dev-stack.mjs up
 *   node scripts/verify-purge.mjs
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

const API = (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const RUNTIME = path.resolve(process.env.RUNTIME_DIR ?? 'runtime');
const run = `p${Date.now().toString(36)}`;
let cookie = '';
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
  if (!ok) failed++;
};
async function call(method, url, { json, body } = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { ...(cookie && { cookie }), ...(json !== undefined && { 'content-type': 'application/json' }) },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text), text };
  } catch {
    return { status: res.status, data: null, text };
  }
}
const q = encodeURIComponent;
const put = (bucket, key, buf) => call('PUT', `/api/buckets/${bucket}/object?key=${q(key)}`, { body: buf });
const details = async (bucket, key) => (await call('GET', `/api/buckets/${bucket}/object/details?key=${q(key)}`)).data;
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(1000);
  }
  return false;
}

console.log(`retention purge check against ${API}`);
await call('POST', '/api/auth/register', { json: { email: `${run}@example.com`, password: 'purge-password-1' } });
const sys = (await call('GET', '/api/system')).data;
if (sys?.config?.retentionHours !== 0) {
  console.log(`  - skipped: API retention is ${sys?.config?.retentionHours}h (start the stack with RETENTION_HOURS=0)`);
  process.exit(0);
}
const bucket = `purge-${run}`;
await call('POST', '/api/buckets', { json: { name: bucket } });

await put(bucket, 'gone.bin', randomBytes(5000));
const files = (await details(bucket, 'gone.bin')).replicas.map((r) => path.join(RUNTIME, r.blobPath));
check('blob files exist on both nodes before delete', files.length === 2 && files.every((f) => existsSync(f)));
await call('DELETE', `/api/buckets/${bucket}/object?key=gone.bin`);
check('purge removes the blob from every node', await until(() => files.every((f) => !existsSync(f)), 90_000));
check('purged version is tombstoned as PURGED', (await details(bucket, 'gone.bin')).versions.every((v) => v.state === 'PURGED'));
check('a purged object can no longer be restored', (await call('GET', `/api/buckets/${bucket}/objects/deleted`)).data.items.every((i) => i.key !== 'gone.bin'));

// A blob shared by a restored version must survive the purge of the versions that originally owned it.
await put(bucket, 'shared.txt', Buffer.from('shared one'));
const v1 = (await details(bucket, 'shared.txt')).versions[0];
const v1Files = (await details(bucket, 'shared.txt')).replicas.map((r) => path.join(RUNTIME, r.blobPath));
await put(bucket, 'shared.txt', Buffer.from('shared two')); // v1 -> DELETED, due immediately
const restored = await call('POST', `/api/buckets/${bucket}/object/restore?key=shared.txt&versionId=${v1.versionId}`);
check('restore races ahead of the purge', restored.status === 200, restored.text);
await until(async () => (await details(bucket, 'shared.txt')).versions.filter((v) => v.state === 'PURGED').length >= 1, 60_000);
const dl = await fetch(`${API}/api/buckets/${bucket}/object?key=shared.txt`, { headers: { cookie } });
check('restored version still downloads after its source version was purged', dl.status === 200 && (await dl.text()) === 'shared one');
check('the shared blob was NOT deleted from disk (reference counted)', v1Files.every((f) => existsSync(f)));

console.log(failed ? `\nFAILED (${failed})` : '\nALL PURGE CHECKS PASSED');
process.exit(failed ? 1 : 0);
