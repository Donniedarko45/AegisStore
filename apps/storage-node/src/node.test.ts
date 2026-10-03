import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore } from './blobstore';
import { MetricsCollector } from './metrics';
import { buildServer } from './server';

const SECRET = 'test-secret-123';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const auth = { authorization: `Bearer ${SECRET}` };

let dir: string;
let base: string;
let store: BlobStore;
let close: () => Promise<unknown>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aegis-node-'));
  store = new BlobStore(dir, 1024 * 1024);
  await store.init();
  const app = await buildServer({ store, metrics: new MetricsCollector(), secret: SECRET, nodeName: 'test', logLevel: 'silent' });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  close = async () => {
    await app.close();
  };
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

const id = () => crypto.randomUUID();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => (await r.json()) as any;
const put = (blobId: string, body: Buffer) =>
  fetch(`${base}/internal/blobs/${blobId}/stage`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    body,
  });
const commit = (blobId: string, stagedToken: string) =>
  fetch(`${base}/internal/blobs/${blobId}/commit`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ stagedToken }),
  });

describe('storage node', () => {
  it('rejects requests without the shared secret', async () => {
    expect((await fetch(`${base}/internal/health`)).status).toBe(401);
    expect((await fetch(`${base}/internal/health`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('stages, commits, reads back, verifies and deletes a blob', async () => {
    const blobId = id();
    const data = Buffer.from('hello aegisstore '.repeat(1000));

    const staged = await json(await put(blobId, data));
    expect(staged.sha256).toBe(sha(data));
    expect(staged.size).toBe(data.length);

    // not visible until committed
    expect((await fetch(`${base}/internal/blobs/${blobId}`, { headers: auth })).status).toBe(404);

    const c = await commit(blobId, staged.stagedToken);
    expect(c.status).toBe(200);
    expect((await json(c)).path).toBe(`blobs/${blobId.slice(0, 2)}/${blobId}`);

    const got = Buffer.from(await (await fetch(`${base}/internal/blobs/${blobId}`, { headers: auth })).arrayBuffer());
    expect(got.equals(data)).toBe(true);

    const head = await fetch(`${base}/internal/blobs/${blobId}`, { method: 'HEAD', headers: auth });
    expect(head.headers.get('content-length')).toBe(String(data.length));

    const v = await json(await fetch(`${base}/internal/blobs/${blobId}/verify`, { method: 'POST', headers: auth }));
    expect(v.sha256).toBe(sha(data));

    expect(store.blobCount).toBeGreaterThan(0);
    const del = await json(await fetch(`${base}/internal/blobs/${blobId}`, { method: 'DELETE', headers: auth }));
    expect(del.deleted).toBe(true);
    expect((await fetch(`${base}/internal/blobs/${blobId}`, { headers: auth })).status).toBe(404);
  });

  it('commit is idempotent', async () => {
    const blobId = id();
    const staged = await json(await put(blobId, Buffer.from('abc')));
    expect((await commit(blobId, staged.stagedToken)).status).toBe(200);
    expect((await commit(blobId, staged.stagedToken)).status).toBe(200);
    expect(store.blobCount).toBeGreaterThan(0);
  });

  it('abort removes a staged blob so it can no longer be committed', async () => {
    const blobId = id();
    const staged = await json(await put(blobId, Buffer.from('abort me')));
    await fetch(`${base}/internal/blobs/${blobId}/stage/${staged.stagedToken}`, { method: 'DELETE', headers: auth });
    expect((await commit(blobId, staged.stagedToken)).status).toBe(404);
  });

  it('supports empty blobs', async () => {
    const blobId = id();
    const staged = await json(await put(blobId, Buffer.alloc(0)));
    expect(staged.size).toBe(0);
    expect(staged.sha256).toBe(sha(''));
  });

  it('refuses non-uuid blob ids (path traversal)', async () => {
    const res = await fetch(`${base}/internal/blobs/..%2F..%2Fetc%2Fpasswd`, { headers: auth });
    expect([400, 404]).toContain(res.status);
    expect(() => store.blobPath('../../etc/passwd')).toThrow();
  });

  it('rejects writes that exceed capacity', async () => {
    const res = await put(id(), Buffer.alloc(2 * 1024 * 1024));
    expect(res.status).toBe(507);
  });

  it('detects on-disk corruption through verify', async () => {
    const blobId = id();
    const data = Buffer.from('precious data');
    const staged = await json(await put(blobId, data));
    await commit(blobId, staged.stagedToken);
    await writeFile(store.blobPath(blobId), 'bit rot!!!!!!!');
    const v = await json(await fetch(`${base}/internal/blobs/${blobId}/verify`, { method: 'POST', headers: auth }));
    expect(v.sha256).not.toBe(sha(data));
    expect((await readFile(store.blobPath(blobId))).toString()).toBe('bit rot!!!!!!!');
  });
});
