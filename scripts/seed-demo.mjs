#!/usr/bin/env node
/**
 * Fills a running AegisStore with realistic demo data so every chart and figure has something
 * to show: several buckets, folder trees, mixed content types and sizes, downloads, an overwrite
 * (version history), a delete (recently deleted) and a shared bucket.
 *
 *   API_URL=http://localhost:8080 node scripts/seed-demo.mjs
 */
import { randomBytes } from 'node:crypto';

const API = (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@aegis.local';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
let cookie = '';

async function call(method, url, { json, body, type } = {}) {
  const headers = { ...(cookie && { cookie }) };
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (type) headers['content-type'] = type;
  const res = await fetch(`${API}${url}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
  const text = await res.text();
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const q = encodeURIComponent;
const put = (bucket, key, buf, type) => call('PUT', `/api/buckets/${bucket}/object?key=${q(key)}`, { body: buf, type });
const get = (bucket, key) => fetch(`${API}/api/buckets/${bucket}/object?key=${q(key)}`, { headers: { cookie } }).then((r) => r.arrayBuffer());
const text = (s) => Buffer.from(s);
const blob = (kb) => randomBytes(Math.round(kb * 1024));

await call('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } });

const buckets = [
  { name: 'research-data', versioningEnabled: true },
  { name: 'marketing-assets', publicRead: true },
  { name: 'backups' },
  { name: 'ml-datasets', versioningEnabled: true },
];
for (const b of buckets) await call('POST', '/api/buckets', { json: { versioningEnabled: false, publicRead: false, ...b } });

const files = [
  ['research-data', 'reports/2026/q1-summary.pdf', blob(420), 'application/pdf'],
  ['research-data', 'reports/2026/q2-summary.pdf', blob(380), 'application/pdf'],
  ['research-data', 'reports/2026/q3-board-deck — FINAL (revised) v12.pdf', blob(2100), 'application/pdf'],
  ['research-data', 'notebooks/analysis.ipynb', blob(96), 'application/x-ipynb+json'],
  ['research-data', 'notebooks/clean_data.py', text('import pandas as pd\n'.repeat(400)), 'text/x-python'],
  ['research-data', 'README.md', text('# Research data\n\nShared datasets and reports.\n'), 'text/markdown'],
  ['marketing-assets', 'images/hero@2x.png', blob(1800), 'image/png'],
  ['marketing-assets', 'images/logo.svg', text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
  ['marketing-assets', 'images/IMG_20250914_183022_HDR_portrait_edited_edited.HEIC', blob(3400), 'image/heic'],
  ['marketing-assets', 'video/launch-teaser.mp4', blob(18_500), 'video/mp4'],
  ['marketing-assets', 'copy/landing-page.md', text('Store anything. Lose nothing.\n'), 'text/markdown'],
  ['backups', 'postgres/2026-10-01.sql.gz', blob(6200), 'application/gzip'],
  ['backups', 'postgres/2026-10-02.sql.gz', blob(6400), 'application/gzip'],
  ['backups', 'postgres/2026-10-03.sql.gz', blob(6550), 'application/gzip'],
  ['backups', 'configs/nginx.conf', text('server { listen 8080; }\n'), 'text/plain'],
  ['ml-datasets', 'imagenet-subset/train.tar', blob(24_000), 'application/x-tar'],
  ['ml-datasets', 'imagenet-subset/val.tar', blob(5200), 'application/x-tar'],
  ['ml-datasets', 'embeddings/v1.parquet', blob(3100), 'application/vnd.apache.parquet'],
  ['ml-datasets', 'embeddings/v2.parquet', blob(3300), 'application/vnd.apache.parquet'],
  ['ml-datasets', '🦊 experiments/run-01/metrics.json', text(JSON.stringify({ loss: 0.12, acc: 0.97 })), 'application/json'],
];
for (const [b, k, buf, t] of files) {
  await put(b, k, buf, t);
  process.stdout.write('.');
}

// version history + a restorable delete
await put('research-data', 'README.md', text('# Research data\n\nShared datasets, reports and notebooks.\n'), 'text/markdown');
await put('research-data', 'README.md', text('# Research data (v3)\n\nNow with a data dictionary.\n'), 'text/markdown');
await call('DELETE', `/api/buckets/backups/object?key=${q('configs/nginx.conf')}`);

// downloads (drive "most downloaded" and egress)
const hot = [
  ['marketing-assets', 'images/hero@2x.png', 9],
  ['research-data', 'reports/2026/q3-board-deck — FINAL (revised) v12.pdf', 6],
  ['ml-datasets', 'embeddings/v2.parquet', 4],
  ['backups', 'postgres/2026-10-03.sql.gz', 2],
];
for (const [b, k, n] of hot) for (let i = 0; i < n; i++) await get(b, k);

console.log(`\nseeded ${buckets.length} buckets and ${files.length} objects at ${API}`);
