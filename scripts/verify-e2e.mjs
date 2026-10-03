#!/usr/bin/env node
/**
 * End-to-end verification of AegisStore against a RUNNING stack.
 *
 *   API_URL            default http://127.0.0.1:3000   (use http://localhost:8080 through nginx)
 *   ADMIN_EMAIL/ADMIN_PASSWORD  default admin@aegis.local / ChangeMe123!
 *   RUNTIME_DIR        default ./runtime  - used to inspect/corrupt blobs on disk (skipped if absent)
 *   STOP_NODE_CMD      default "docker compose stop {node}"   ({node} is replaced)
 *   START_NODE_CMD     default "docker compose start {node}"
 *
 * Local (no Docker):  STOP_NODE_CMD="node scripts/dev-stack.mjs stop {node}" \
 *                     START_NODE_CMD="node scripts/dev-stack.mjs start {node}" node scripts/verify-e2e.mjs
 */
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const API = (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@aegis.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
const RUNTIME = path.resolve(process.env.RUNTIME_DIR ?? 'runtime');
const STOP = process.env.STOP_NODE_CMD ?? 'docker compose stop {node}';
const START = process.env.START_NODE_CMD ?? 'docker compose start {node}';
const run = `e2e${Date.now().toString(36)}`;

let passed = 0;
const failures = [];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `  -> ${detail}` : ''}`);
  }
}
const section = (t) => console.log(`\n${t}`);

/** Minimal client with a cookie jar so each instance behaves like one logged-in browser. */
class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
    this.bearer = null;
  }
  async req(method, url, { json, body, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    if (json !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(`${API}${url}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [pair] = c.split(';');
      if (pair.endsWith('=')) this.cookie = '';
      else this.cookie = pair;
    }
    if (raw) return res;
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  get = (u, o) => this.req('GET', u, o);
  post = (u, json, o) => this.req('POST', u, { json, ...o });
  put = (u, json, o) => this.req('PUT', u, { json, ...o });
  del = (u, o) => this.req('DELETE', u, o);
}

const q = encodeURIComponent;
const objUrl = (bucket, key, extra = '') => `/api/buckets/${bucket}/object?key=${q(key)}${extra}`;
const upload = (c, bucket, key, buf, type = 'application/octet-stream') =>
  c.req('PUT', objUrl(bucket, key), { body: buf, headers: { 'content-type': type } });

async function download(c, bucket, key) {
  const res = await c.req('GET', objUrl(bucket, key), { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, headers: res.headers };
}

async function waitFor(desc, fn, timeoutMs = 45_000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${desc}`);
    await sleep(every);
  }
}

const nodeStatus = async (c) => Object.fromEntries((await c.get('/api/nodes')).data.items.map((n) => [n.name, n.status]));
const stopNode = (n) => execSync(STOP.replace('{node}', n), { stdio: 'pipe' });
const startNode = (n) => execSync(START.replace('{node}', n), { stdio: 'pipe' });
const blobFile = (replica) => path.join(RUNTIME, replica.blobPath); // e.g. runtime/storage-node-1/blobs/ab/<id>

// =============================================================================================
console.log(`AegisStore e2e against ${API}  (run ${run})`);

section('0. Platform is up');
await waitFor('API readiness (>=2 healthy nodes)', async () => (await fetch(`${API}/readyz`)).status === 200, 90_000, 2000);
check('API ready with enough healthy storage nodes', true);

const admin = new Client('admin');
let r = await admin.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
check('seeded admin can log in', r.status === 200 && r.data.user.role === 'ADMIN', JSON.stringify(r.data));
r = await admin.post('/api/auth/login', { email: ADMIN_EMAIL, password: 'wrong-password' });
check('wrong password is rejected (401)', r.status === 401);

section('1. Accounts');
const alice = new Client('alice');
const bob = new Client('bob');
r = await alice.post('/api/auth/register', { email: `alice-${run}@example.com`, password: 'alice-password-1' });
check('register creates a MEMBER (never ADMIN)', r.status === 201 && r.data.user.role === 'MEMBER');
r = await alice.post('/api/auth/register', { email: `alice-${run}@example.com`, password: 'alice-password-1' });
check('duplicate email -> 409', r.status === 409);
await bob.post('/api/auth/register', { email: `bob-${run}@example.com`, password: 'bob-password-1' });
r = await alice.get('/api/auth/me');
check('session cookie authenticates /me', r.status === 200 && r.data.user.email.startsWith('alice'));
r = await new Client('anon').get('/api/auth/me');
check('no credentials -> 401', r.status === 401);

section('2. Buckets');
const bucket = `e2e-${run}`;
r = await alice.post('/api/buckets', { name: bucket });
check('create bucket', r.status === 201 && r.data.bucket.name === bucket, JSON.stringify(r.data));
r = await alice.post('/api/buckets', { name: bucket });
check('duplicate bucket name -> 409', r.status === 409);
r = await alice.post('/api/buckets', { name: 'Bad_Name' });
check('invalid bucket name -> 400', r.status === 400);
r = await bob.get(`/api/buckets/${bucket}`);
check("another user cannot even see a private bucket (404)", r.status === 404);
r = await alice.get('/api/buckets');
check('owner lists their bucket', r.data.items.some((b) => b.name === bucket));

section('3. Upload -> replication -> checksum');
const small = randomBytes(300_000);
const key = `docs/report-${run}.bin`;
r = await upload(alice, bucket, key, small, 'application/pdf');
check('upload returns 201', r.status === 201, JSON.stringify(r.data));
check('stored on exactly 2 distinct nodes', r.data?.replicas?.length === 2 && new Set(r.data.replicas.map((x) => x.node)).size === 2);
check('API reports the correct SHA-256', r.data?.sha256 === sha(small));
const holders = r.data?.replicas?.map((x) => x.node) ?? [];

r = await alice.get(`/api/buckets/${bucket}/object/details?key=${q(key)}`);
const details = r.data;
check('details: integrity HEALTHY', details.current?.integrity === 'HEALTHY');
check('details: both replicas checksum "Match"', details.replicas.length === 2 && details.replicas.every((x) => x.checksumMatch));
check('details: version list present', details.versions.length === 1 && details.versions[0].isCurrent);

let onDisk = 0;
if (existsSync(RUNTIME)) {
  for (const rep of details.replicas) if (existsSync(blobFile(rep))) onDisk++;
  check('blob physically exists on both node folders', onDisk === 2, `found ${onDisk}`);
} else {
  console.log('  - (skipped on-disk checks: RUNTIME_DIR not found)');
}

let d = await download(alice, bucket, key);
check('download returns identical bytes', d.status === 200 && sha(d.buf) === sha(small));
check('download reports integrity verified', d.headers.get('x-aegis-integrity') === 'verified');
check('content-type preserved', d.headers.get('content-type') === 'application/pdf');
check('downloads are forced to attachment', (d.headers.get('content-disposition') ?? '').startsWith('attachment'));

r = await alice.get(`/api/buckets/${bucket}/objects?q=report`);
check('search finds the object', r.data.items.length === 1 && r.data.items[0].key === key && r.data.total === 1);
r = await alice.get(`/api/buckets/${bucket}/objects?prefix=nope/`);
check('prefix filter excludes it', r.data.items.length === 0);
r = await alice.get(`/api/buckets/${bucket}/objects?integrity=DEGRADED`);
check('integrity filter (DEGRADED) is empty while healthy', r.data.items.length === 0);

section('3b. Streaming & limits');
const big = randomBytes(24 * 1024 * 1024); // > VERIFY_BUFFER_MAX (16 MB) => streaming verification path
r = await upload(alice, bucket, `big-${run}.bin`, big);
check('24 MB upload succeeds', r.status === 201 && r.data.sha256 === sha(big), JSON.stringify(r.data)?.slice(0, 200));
d = await download(alice, bucket, `big-${run}.bin`);
check('24 MB download is byte-identical (streamed + verified)', d.status === 200 && sha(d.buf) === sha(big));
check('large download uses streaming verification', d.headers.get('x-aegis-integrity') === 'streaming');
r = await upload(alice, bucket, '../escape', Buffer.from('x'));
check('path traversal key rejected (400)', r.status === 400);
r = await upload(alice, bucket, '', Buffer.from('x'));
check('empty key rejected (400)', r.status === 400);
r = await upload(alice, bucket, `empty-${run}`, Buffer.alloc(0));
check('zero-byte object can be stored', r.status === 201 && r.data.size === 0);
check('over-limit upload is refused (413)', await new Promise((resolve) => {
  const u = new URL(`${API}${objUrl(bucket, 'huge')}`);
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT', headers: { 'content-length': String(500 * 1024 * 1024), 'content-type': 'application/octet-stream', cookie: alice.cookie } }, (res) => {
    resolve(res.statusCode === 413);
    req.destroy();
  });
  req.on('error', () => resolve(false));
  req.write('x');
}));

section('4. Versioning off: overwrite + delete');
r = await upload(alice, bucket, key, Buffer.from('second version'));
check('overwrite creates version 2', r.status === 201 && r.data.versionNo === 2);
d = await download(alice, bucket, key);
check('download serves the newest bytes', d.buf.toString() === 'second version');
r = await alice.get(`/api/buckets/${bucket}/object/details?key=${q(key)}`);
check('version history lists both', r.data.versions.length === 2);

section('5. Node failure -> fallback');
const stopped = holders[0];
const survivor = holders[1];
const bigDetails = (await alice.get(`/api/buckets/${bucket}/object/details?key=${q(`big-${run}.bin`)}`)).data;
console.log(`  (stopping ${stopped}; object currently on ${holders.join(' + ')})`);
r = await upload(alice, bucket, `fallback-${run}.txt`, Buffer.from('fallback payload'));
const fbHolders = r.data.replicas.map((x) => x.node);
const victim = fbHolders[0];
const other = fbHolders[1];
stopNode(victim);
await waitFor(`${victim} to be marked OFFLINE`, async () => (await nodeStatus(alice))[victim] === 'OFFLINE', 45_000);
check(`${victim} detected OFFLINE by the worker`, true);
r = await alice.get(`/api/buckets/${bucket}/object/details?key=${q(`fallback-${run}.txt`)}`);
check('object integrity shows DEGRADED', r.data.current.integrity === 'DEGRADED', r.data.current.integrity);
d = await download(alice, bucket, `fallback-${run}.txt`);
check('download still works from the surviving replica', d.status === 200 && d.buf.toString() === 'fallback payload');
check(`served by ${other}`, d.headers.get('x-aegis-served-by') === other, d.headers.get('x-aegis-served-by'));
r = await alice.get(`/api/buckets/${bucket}/objects?integrity=DEGRADED`);
check('integrity filter finds the degraded object', r.data.items.some((i) => i.key === `fallback-${run}.txt`));
r = await alice.get('/api/dashboard/summary');
check('dashboard shows 2 healthy / 1 at-risk', r.data.nodes.healthy === 2 && r.data.nodes.atRisk === 1, JSON.stringify(r.data.nodes));
r = await upload(alice, bucket, `during-outage-${run}.txt`, Buffer.from('written while a node is down'));
check('uploads still succeed with 2 healthy nodes', r.status === 201 && !r.data.replicas.some((x) => x.node === victim));

section('5b. Not enough healthy nodes -> 503');
const third = ['storage-node-1', 'storage-node-2', 'storage-node-3'].find((n) => n !== victim && n !== other);
stopNode(third);
await waitFor(`${third} to be marked OFFLINE`, async () => (await nodeStatus(alice))[third] === 'OFFLINE', 45_000);
// Only `other`'s node is healthy now: R=2 cannot be met
r = await upload(alice, bucket, `rejected-${run}.txt`, Buffer.from('should be rejected'));
check('upload rejected with 503 INSUFFICIENT_HEALTHY_NODES', r.status === 503 && r.data.error.code === 'INSUFFICIENT_HEALTHY_NODES', JSON.stringify(r.data));
d = await download(alice, bucket, `fallback-${run}.txt`);
check('reads of existing data still work from the last healthy replica', d.status === 200);

section('5c. Recovery');
startNode(victim);
startNode(third);
await waitFor('both nodes HEALTHY again (probation passed)', async () => {
  const s = await nodeStatus(alice);
  return s[victim] === 'HEALTHY' && s[third] === 'HEALTHY';
}, 60_000);
check('restarted nodes return to HEALTHY after probation', true);
r = await alice.get(`/api/buckets/${bucket}/object/details?key=${q(`fallback-${run}.txt`)}`);
check('object integrity back to HEALTHY', r.data.current.integrity === 'HEALTHY', r.data.current.integrity);

section('6. Corruption detection');
if (existsSync(RUNTIME)) {
  const ckey = `corrupt-${run}.bin`;
  const payload = randomBytes(100_000);
  await upload(alice, bucket, ckey, payload);
  const cd = (await alice.get(`/api/buckets/${bucket}/object/details?key=${q(ckey)}`)).data;
  const bad = cd.replicas[0];
  writeFileSync(blobFile(bad), Buffer.concat([readFileSync(blobFile(bad)).subarray(0, 50_000), Buffer.from('BITROT')]));
  let allGood = true;
  let flagged = false;
  for (let i = 0; i < 25 && !flagged; i++) {
    const x = await download(alice, bucket, ckey);
    allGood &&= x.status === 200 && sha(x.buf) === sha(payload);
    const now = (await alice.get(`/api/buckets/${bucket}/object/details?key=${q(ckey)}`)).data;
    flagged = now.replicas.find((y) => y.id === bad.id)?.state === 'CORRUPT';
  }
  check('every download returned correct bytes despite a corrupt replica', allGood);
  check('corrupt replica was detected and marked CORRUPT', flagged);
  const after = (await alice.get(`/api/buckets/${bucket}/object/details?key=${q(ckey)}`)).data;
  check('integrity now DEGRADED and the bad replica shows a checksum mismatch', after.current.integrity === 'DEGRADED' && !after.replicas.find((y) => y.id === bad.id).checksumMatch);
} else {
  console.log('  - (skipped: RUNTIME_DIR not found)');
}

section('7. Permissions & API keys');
r = await bob.put(`/api/buckets/${bucket}/grants`, { email: `bob-${run}@example.com`, permission: 'READ' });
check('non-owner cannot manage grants', r.status === 404 || r.status === 403, String(r.status));
r = await alice.put(`/api/buckets/${bucket}/grants`, { email: `bob-${run}@example.com`, permission: 'READ' });
check('owner grants READ to bob', r.status === 200);
r = await bob.get(`/api/buckets/${bucket}/objects`);
check('bob can now list', r.status === 200 && r.data.items.length > 0);
d = await download(bob, bucket, `fallback-${run}.txt`);
check('bob can download', d.status === 200);
r = await upload(bob, bucket, 'bob-write.txt', Buffer.from('nope'));
check('bob (READ) cannot upload -> 403', r.status === 403);
r = await bob.del(objUrl(bucket, key));
check('bob (READ) cannot delete -> 403', r.status === 403);
await alice.put(`/api/buckets/${bucket}/grants`, { email: `bob-${run}@example.com`, permission: 'WRITE' });
r = await upload(bob, bucket, 'bob-write.txt', Buffer.from('now allowed'));
check('after upgrade to WRITE bob can upload', r.status === 201);
r = await alice.get(`/api/buckets/${bucket}/grants`);
check('grants list shows bob', r.data.items.some((g) => g.email.startsWith('bob') && g.permission === 'WRITE'));

r = await alice.post('/api/api-keys', { name: 'e2e key', scopes: ['read'] });
check('API key created and shown once', r.status === 201 && /^aegis_[0-9a-f]{8}_/.test(r.data.key));
const keyId = r.data.id;
const keyClient = new Client('key');
keyClient.bearer = r.data.key;
r = await keyClient.get('/api/buckets');
check('Bearer API key authenticates', r.status === 200 && r.data.items.some((b) => b.name === bucket));
r = await upload(keyClient, bucket, 'via-key.txt', Buffer.from('x'));
check('read-scoped key cannot write -> 403', r.status === 403);
r = await keyClient.post('/api/api-keys', { name: 'child' });
check('API keys cannot mint new keys', r.status === 403);
r = await alice.get('/api/api-keys');
check('key list never reveals the secret', !JSON.stringify(r.data).includes(keyClient.bearer.split('_')[2]));
await alice.del(`/api/api-keys/${keyId}`);
r = await keyClient.get('/api/buckets');
check('revoked key stops working (401)', r.status === 401);

section('8. Public-read bucket');
const pub = `pub-${run}`;
await alice.post('/api/buckets', { name: pub, publicRead: true });
await upload(alice, pub, 'hello.txt', Buffer.from('hello world'));
const anon = new Client('anon');
d = await download(anon, pub, 'hello.txt');
check('anonymous can download from a public-read bucket', d.status === 200 && d.buf.toString() === 'hello world');
r = await anon.get(`/api/buckets/${pub}/objects`);
check('anonymous can list a public-read bucket', r.status === 200);
r = await upload(anon, pub, 'evil.txt', Buffer.from('x'));
check('anonymous cannot write (401)', r.status === 401);
d = await download(anon, bucket, `fallback-${run}.txt`);
check('anonymous cannot read a private bucket (401)', d.status === 401);

section('9. Delete');
r = await bob.del(objUrl(bucket, `fallback-${run}.txt`));
check('WRITE user can delete an object', r.status === 200);
d = await download(alice, bucket, `fallback-${run}.txt`);
check('deleted object -> 404', d.status === 404);
r = await bob.del(`/api/buckets/${bucket}`);
check('a WRITE grantee cannot delete the bucket', r.status === 403, String(r.status));
r = await alice.del(`/api/buckets/${bucket}`);
check('non-empty bucket cannot be deleted (409)', r.status === 409 && r.data.error.code === 'BUCKET_NOT_EMPTY');
const left = (await alice.get(`/api/buckets/${bucket}/objects?pageSize=200`)).data.items;
for (const o of left) await alice.del(objUrl(bucket, o.key));
r = await alice.del(`/api/buckets/${bucket}`);
check('empty bucket can be deleted', r.status === 200);
r = await alice.get(`/api/buckets/${bucket}`);
check('deleted bucket is gone (404)', r.status === 404);

section('10. Audit trail');
r = await alice.get('/api/audit?pageSize=200');
const actions = new Set(r.data.items.map((i) => i.action));
check('member sees their own audit entries', ['auth.register', 'bucket.create', 'object.upload', 'object.download', 'object.delete', 'grant.set', 'apikey.create'].every((a) => actions.has(a)), [...actions].join(','));
check('member trail contains no one else\'s entries', r.data.items.every((i) => (i.actor ?? '').startsWith('alice') || i.actorType === 'SYSTEM'));
r = await admin.get('/api/audit?action=node.&pageSize=100');
const nodeActions = new Set(r.data.items.map((i) => i.action));
check('admin sees node.offline / node.online system events', nodeActions.has('node.offline') && nodeActions.has('node.online'), [...nodeActions].join(','));
r = await alice.get('/api/audit/verify');
check('members cannot run chain verification (403)', r.status === 403);
r = await admin.get('/api/audit/verify');
check('audit hash chain verifies', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));

section('11. Dashboard & nodes');
r = await alice.get('/api/dashboard/summary');
check('dashboard summary has storage + nodes', r.status === 200 && r.data.nodes.total >= 3 && r.data.perNode.length >= 3);
r = await alice.get('/api/nodes');
check('node list has ring share summing to ~100%', Math.abs(r.data.items.reduce((a, n) => a + n.ringSharePct, 0) - 100) < 1);
const nid = r.data.items[0].id;
r = await alice.get(`/api/nodes/${nid}`);
check('node details return metrics history', r.status === 200 && Array.isArray(r.data.history));

section('12. Restore & recently deleted');
const rb = `restore-${run}`;
await alice.post('/api/buckets', { name: rb });
await upload(alice, rb, 'doc.txt', Buffer.from('version one'));
await upload(alice, rb, 'doc.txt', Buffer.from('version two'));
let det = (await alice.get(`/api/buckets/${rb}/object/details?key=doc.txt`)).data;
const v1 = det.versions.find((v) => v.versionNo === 1);
check('overwrite (unversioned) keeps v1 as DELETED with a purge date', v1?.state === 'DELETED' && !!v1.purgeAfter, JSON.stringify(v1));
check('details expose ring placement', typeof det.placement?.ringPos === 'number' && det.placement.ringPos >= 0 && det.placement.ringPos < 1 && det.placement.ringOrder.length >= 3);
r = await alice.post(`/api/buckets/${rb}/object/restore?key=doc.txt&versionId=${v1.versionId}`);
check('restore an overwritten version', r.status === 200 && r.data.versionNo === 3, JSON.stringify(r.data));
d = await download(alice, rb, 'doc.txt');
check('download serves the restored bytes', d.buf.toString() === 'version one');
det = (await alice.get(`/api/buckets/${rb}/object/details?key=doc.txt`)).data;
check('restored version reuses the blob (replicas still verified)', det.replicas.length === 2 && det.replicas.every((x) => x.checksumMatch));
r = await alice.post(`/api/buckets/${rb}/object/restore?key=doc.txt&versionId=${det.current.versionId}`);
check('restoring the current version is rejected (409)', r.status === 409);
await alice.del(objUrl(rb, 'doc.txt'));
r = await alice.get(`/api/buckets/${rb}/objects/deleted`);
const gone = r.data.items.find((i) => i.key === 'doc.txt');
check('deleted object appears in "recently deleted"', !!gone && !!gone.purgeAfter);
r = await alice.post(`/api/buckets/${rb}/object/restore?key=doc.txt&versionId=${gone.versionId}`);
check('undo delete restores it', r.status === 200);
d = await download(alice, rb, 'doc.txt');
check('undeleted object downloads again', d.status === 200 && d.buf.toString() === 'version one');
r = await bob.post(`/api/buckets/${rb}/object/restore?key=doc.txt&versionId=${gone.versionId}`);
check('users without access cannot restore (404)', r.status === 404);

section('13. Password & sessions');
const carol = new Client('carol');
const carolEmail = `carol-${run}@example.com`;
await carol.post('/api/auth/register', { email: carolEmail, password: 'carol-password-1' });
const carol2 = new Client('carol-second-device');
await carol2.post('/api/auth/login', { email: carolEmail, password: 'carol-password-1' });
r = await carol.get('/api/auth/sessions');
check('sessions list shows both devices, one marked current', r.data.items.length === 2 && r.data.items.filter((x) => x.current).length === 1);
r = await carol.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'carol-password-2' });
check('wrong current password is rejected', r.status === 400);
r = await carol.post('/api/auth/password', { currentPassword: 'carol-password-1', newPassword: 'carol-password-2' });
check('password change succeeds and revokes the other session', r.status === 200 && r.data.revokedSessions === 1);
check('current session survives the change', (await carol.get('/api/auth/me')).status === 200);
check('other device is signed out (401)', (await carol2.get('/api/auth/me')).status === 401);
check('old password no longer works', (await new Client('x').post('/api/auth/login', { email: carolEmail, password: 'carol-password-1' })).status === 401);
check('new password works', (await new Client('y').post('/api/auth/login', { email: carolEmail, password: 'carol-password-2' })).status === 200);

section('14. User administration');
r = await alice.get('/api/users');
check('members cannot list users (403)', r.status === 403);
r = await admin.get('/api/users');
const bobRow = r.data.items.find((u) => u.email === `bob-${run}@example.com`);
check('admin lists users with usage stats', r.status === 200 && !!bobRow && typeof bobRow.bytes === 'number');
const me = (await admin.get('/api/auth/me')).data.user;
r = await admin.req('PATCH', `/api/users/${me.id}`, { json: { role: 'MEMBER' } });
check('admins cannot demote themselves (403)', r.status === 403);
r = await admin.req('PATCH', `/api/users/${bobRow.id}`, { json: { status: 'DISABLED' } });
check('admin disables a user', r.status === 200);
check('disabled user is signed out immediately (401)', (await bob.get('/api/auth/me')).status === 401);
check('disabled user cannot sign in', (await bob.post('/api/auth/login', { email: `bob-${run}@example.com`, password: 'bob-password-1' })).status === 401);
await admin.req('PATCH', `/api/users/${bobRow.id}`, { json: { status: 'ACTIVE' } });
check('re-enabled user can sign in again', (await bob.post('/api/auth/login', { email: `bob-${run}@example.com`, password: 'bob-password-1' })).status === 200);

section('15. Analytics, ring, uptime, system');
r = await alice.get('/api/analytics/overview?range=1h');
check('analytics: gap-filled activity series', r.status === 200 && r.data.activity.length >= 59 && r.data.totals.uploads > 0, `${r.data.activity?.length} points, ${r.data.totals?.uploads} uploads`);
check('analytics: storage, breakdowns and histogram present', r.data.storage.length >= 59 && Array.isArray(r.data.byType) && r.data.sizeHistogram.length === 5 && typeof r.data.integrity.healthy === 'number');
r = await alice.get('/api/nodes/ring');
check('ring: 3 x 128 virtual nodes, shares sum to ~100%', r.data.points.length === 384 && Math.abs(r.data.nodes.reduce((a, n) => a + n.sharePct, 0) - 100) < 1);
r = await alice.get('/api/nodes/uptime?range=1h');
const withIncident = r.data.nodes.find((n) => n.incidents.length > 0);
check('uptime: bars per node and the earlier outages recorded as incidents', r.data.nodes.length >= 3 && r.data.nodes[0].bars.length === 60 && !!withIncident, JSON.stringify(r.data.nodes.map((n) => [n.name, n.uptimePct, n.incidents.length])));
r = await alice.get('/api/nodes/metrics?range=1h');
check('metrics: per-node series', r.status === 200 && r.data.nodes.length >= 3 && Array.isArray(r.data.latencyP95));
r = await alice.get('/api/system');
check('system info reports components and config', r.data.components.database === 'up' && r.data.config.replicationFactor === 2);

section('16. Live events (SSE)');
{
  const ctl = new AbortController();
  const res = await fetch(`${API}/api/events/stream`, { headers: { cookie: alice.cookie }, signal: ctl.signal });
  check('event stream opens as text/event-stream', res.status === 200 && (res.headers.get('content-type') ?? '').startsWith('text/event-stream'));
  const seen = new Set();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const m of buf.matchAll(/^event: (\S+)$/gm)) seen.add(m[1]);
      }
    } catch { /* aborted */ }
  })();
  await sleep(400);
  await upload(alice, rb, 'live.txt', Buffer.from('live'));
  await waitFor('node.metrics and object.created events', async () => seen.has('node.metrics') && seen.has('object.created'), 15_000, 250).catch(() => null);
  check('receives ready, live node metrics and object events', seen.has('ready') && seen.has('node.metrics') && seen.has('object.created'), [...seen].join(','));
  ctl.abort();
  await pump;
  const anonSse = await fetch(`${API}/api/events/stream`);
  check('event stream requires authentication (401)', anonSse.status === 401);
}

// ---------------------------------------------------------------------------------------------
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILED'}  (${passed} passed, ${failures.length} failed)`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
