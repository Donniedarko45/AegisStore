# AegisStore

A distributed object store inspired by Amazon S3. Files (objects) live in buckets and are **replicated across multiple storage nodes**. Every replica is **SHA-256 verified**, and downloads keep working when a node fails.

```
Browser ──> nginx :8080 (React dashboard + /api proxy)
              │
              ▼
         Backend API ──── Worker (health sweeper, metrics, GC)
              │  │
   PostgreSQL ┘  └ Redis (ephemeral)
              │
   ┌──────────┼──────────┐
 node-1     node-2     node-3   (blobs on disk, heartbeat every 5s)
```

The full design, from requirements and data model to failure handling and the roadmap, is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start

Requirements: Docker with Compose v2.

```bash
cp .env.example .env          # change ADMIN_PASSWORD and the secrets for anything non-local
docker compose up --build
```

Open **http://localhost:8080** and sign in as `admin@aegis.local` / `ChangeMe123!` (or whatever you set in `.env`).

> Behind a TLS-intercepting corporate proxy, image builds may fail with `SELF_SIGNED_CERT_IN_CHAIN`. Build with your proxy's CA:
> `docker build --secret id=extra_ca,src=/path/to/ca.crt --target <api|worker|storage-node|web> -t aegisstore/<target>:dev -f deploy/Dockerfile .`
> Then run `docker compose up` without `--build`.

## Try it

1. **Create a bucket.** Go to Buckets → *Create bucket*, enter a name like `research-data`, then click *Create bucket*.
2. **Upload a file.** Click *Upload object*, choose a file and an optional folder prefix. The dialog shows which 2 nodes received the copies.
3. **Inspect it.** Click the object: *Overview* shows size, SHA-256 and integrity, and *Replicas* shows which node holds each copy plus a checksum **Match**.
4. **Download and verify.** Run `sha256sum <file>` on the downloaded file and compare it with the UI.

### Node failure demo

```bash
docker compose stop storage-node-2     # pick a node that holds a replica (Replicas tab)
```

- Within about 15–20 s the node shows **OFFLINE**, the dashboard shows *Healthy 2/3*, and the object's integrity shows **Degraded**.
- Downloading still works, because the API falls back to the other replica.

```bash
docker compose start storage-node-2    # back to HEALTHY after 3 heartbeats
```

The physical blobs are visible on the host under `runtime/storage-node-N/blobs/<2 chars>/<blob-id>`.

Run the whole demo automatically (115 checks):

```bash
API_URL=http://localhost:8080 node scripts/verify-e2e.mjs
```

## What works today

| Area | Status |
|---|---|
| Register/login, admin seeded from `.env`, sessions, API keys (`Authorization: Bearer …`) | ✅ |
| Buckets: create, search, delete (empty only), versioning flag, public-read | ✅ |
| Objects: streaming upload (≤ 100 MB) with progress, download, delete, search, filters, sort, pagination | ✅ |
| Consistent hash ring (128 vnodes/node), 2 replicas on distinct nodes, `503` if fewer than 2 healthy nodes | ✅ |
| SHA-256 verified on upload (all replicas must match) and on download; bad replicas marked `CORRUPT` | ✅ |
| Replica fallback on node failure; node `OFFLINE` after 15 s, back to `HEALTHY` after probation | ✅ |
| Version restore (including undo-delete within retention), "recently deleted", reference-counted retention purge | ✅ |
| Live updates over SSE: node heartbeats stream into charts, data changes refresh pages without polling | ✅ |
| Analytics: requests, bandwidth, storage growth, content types, size bands, top downloads, per-node latency/CPU/disk I/O | ✅ |
| Interactive hash-ring explorer (place any key, simulate node failures), live cluster topology, status-page uptime | ✅ |
| Password change, session list with per-device sign-out, admin user management (roles, disable/enable) | ✅ |
| Permissions: owner, READ/WRITE/ADMIN grants (API + UI), public-read, enforced server-side | ✅ |
| Tamper-evident (hash-chained) audit log with search and verification | ✅ |
| Multipart, signed URLs, risk scoring, self-healing, HOT/WARM/COLD, adaptive replication, ransomware detection, simulation lab | ⏳ next phases (see the roadmap in the architecture doc) |

### The interface

A Vercel-style dashboard built on [base-ui](https://base-ui.com), [Sonner](https://sonner.emilkowal.ski), [cmdk](https://cmdk.paco.me), [NumberFlow](https://number-flow.barvian.me), [recharts](https://recharts.org) and [Liveline](https://github.com/benjitaylor/liveline). Motion follows Emil Kowalski's design-engineering rules:

- **Curves:** three easing curves only (`--ease-out`, `--ease-in-out`, `--ease-drawer`).
- **Properties:** only transform and opacity are animated.
- **Keyboard actions:** none are animated (the ⌘K menu opens instantly).
- **Reduced motion:** honoured everywhere.

Charts follow a validated colour-blind-safe palette, and every chart has a table view. Press **⌘K / Ctrl+K** anywhere.

Fill a fresh stack with demo data:

```bash
API_URL=http://localhost:8080 node scripts/seed-demo.mjs
```

## Development

Requirements: Node 22 and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm typecheck
pnpm test                         # unit tests (hash ring, storage node, permissions, validation, audit, CSRF)
```

Run everything as local processes, with no Docker. You need PostgreSQL and Redis running; the defaults are `postgres://aegis@localhost:5433/aegis` and `redis://localhost:6380`, and you can override them with `DATABASE_URL` / `REDIS_URL`.

```bash
node scripts/dev-stack.mjs up               # api :3000, worker, storage nodes :4001-4003
pnpm --filter @aegis/web dev                # dashboard on http://localhost:8080 (proxies /api)
node scripts/dev-stack.mjs stop storage-node-2   # simulate a failure
node scripts/dev-stack.mjs down

STOP_NODE_CMD="node scripts/dev-stack.mjs stop {node}" \
START_NODE_CMD="node scripts/dev-stack.mjs start {node}" node scripts/verify-e2e.mjs
```

### Layout

```
apps/
  api/            Fastify backend: auth, buckets, objects, placement, verification, audit
  worker/         leader-elected background jobs (health sweeper, metrics rollup, GC)
  storage-node/   blob server: staged writes, atomic commit, SHA-256, heartbeat
  web/            React + Vite + Tailwind dashboard
packages/
  shared/         zod schemas, enums, DTO types (browser-safe entry: @aegis/shared/web)
  db/             Drizzle schema, migrations, hash-chained audit log
  hashring/       consistent hash ring (pure, unit-tested)
  nodeclient/     typed client for the storage nodes' internal API
deploy/           Dockerfile (targets: api, worker, storage-node, web), nginx config
scripts/          dev-stack.mjs, verify-e2e.mjs
```

### Configuration

All configuration is through environment variables. Each one is documented in [`.env.example`](.env.example) and validated at boot, and a service exits with a clear message if a variable is wrong.
