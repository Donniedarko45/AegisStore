#!/usr/bin/env node
/**
 * Run the whole AegisStore stack as plain local processes (no Docker).
 * Requires a reachable PostgreSQL and Redis (defaults below; override with env).
 *
 *   node scripts/dev-stack.mjs up            start api, worker and 3 storage nodes (detached)
 *   node scripts/dev-stack.mjs down          stop everything
 *   node scripts/dev-stack.mjs stop  <name>  stop one service   (e.g. storage-node-2)
 *   node scripts/dev-stack.mjs start <name>  start one service
 *   node scripts/dev-stack.mjs status        show what is running
 *   node scripts/dev-stack.mjs logs <name>   print a service log
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'runtime', 'dev');
mkdirSync(dir, { recursive: true });

const common = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://aegis@localhost:5433/aegis',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380',
  NODE_SHARED_SECRET: process.env.NODE_SHARED_SECRET ?? 'dev-node-secret-change-me',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? 'admin@aegis.local',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? 'ChangeMe123!',
  OFFLINE_AFTER_MS: process.env.OFFLINE_AFTER_MS ?? '15000',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  // relaxed so the e2e script can be re-run repeatedly; production defaults are 10
  REGISTER_RATE_LIMIT: process.env.REGISTER_RATE_LIMIT ?? '1000',
  LOGIN_RATE_LIMIT: process.env.LOGIN_RATE_LIMIT ?? '1000',
};
const apiPort = process.env.API_PORT ?? '3000';

const services = {
  api: { entry: 'apps/api/src/main.ts', env: { PORT: apiPort, HOST: '127.0.0.1' } },
  worker: { entry: 'apps/worker/src/main.ts', env: {} },
  ...Object.fromEntries(
    [1, 2, 3].map((n) => [
      `storage-node-${n}`,
      {
        entry: 'apps/storage-node/src/main.ts',
        env: {
          NODE_NAME: `storage-node-${n}`,
          PORT: String(4000 + n),
          HOST: '127.0.0.1',
          DATA_DIR: path.join(root, 'runtime', `storage-node-${n}`),
          PUBLIC_URL: `http://127.0.0.1:${4000 + n}`,
          API_URL: `http://127.0.0.1:${apiPort}`,
        },
      },
    ]),
  ),
};

const pidFile = (name) => path.join(dir, `${name}.pid`);
const logFile = (name) => path.join(dir, `${name}.log`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPid = (name) => (existsSync(pidFile(name)) ? Number(readFileSync(pidFile(name), 'utf8')) : null);

function start(name) {
  const svc = services[name];
  if (!svc) throw new Error(`unknown service "${name}" (have: ${Object.keys(services).join(', ')})`);
  const existing = readPid(name);
  if (existing && alive(existing)) return console.log(`${name} already running (pid ${existing})`);
  const out = openSync(logFile(name), 'a');
  const child = spawn(path.join(root, 'node_modules/.bin/tsx'), [svc.entry], {
    cwd: root,
    env: { ...process.env, ...common, ...svc.env },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  closeSync(out);
  writeFileSync(pidFile(name), String(child.pid));
  console.log(`started ${name} (pid ${child.pid})`);
}

async function stop(name) {
  const pid = readPid(name);
  if (!pid || !alive(pid)) {
    rmSync(pidFile(name), { force: true });
    return console.log(`${name} not running`);
  }
  // detached => the child leads its own process group; signal the whole group (tsx spawns node)
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    process.kill(pid, 'SIGTERM');
  }
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  rmSync(pidFile(name), { force: true });
  console.log(`stopped ${name}`);
}

const [cmd, name] = process.argv.slice(2);
switch (cmd) {
  case 'up':
    start('api'); // api first: it runs the migrations
    await new Promise((r) => setTimeout(r, 3000));
    for (const n of Object.keys(services).filter((s) => s !== 'api')) start(n);
    console.log(`\nAPI: http://127.0.0.1:${apiPort}   logs: ${dir}`);
    break;
  case 'down':
    for (const n of Object.keys(services).reverse()) await stop(n);
    break;
  case 'start':
    start(name);
    break;
  case 'stop':
    await stop(name);
    break;
  case 'status':
    for (const n of Object.keys(services)) {
      const pid = readPid(n);
      console.log(`${n.padEnd(16)} ${pid && alive(pid) ? `running (pid ${pid})` : 'stopped'}`);
    }
    break;
  case 'logs':
    process.stdout.write(existsSync(logFile(name)) ? readFileSync(logFile(name), 'utf8') : '(no log)\n');
    break;
  default:
    console.log('usage: dev-stack.mjs up|down|start <svc>|stop <svc>|status|logs <svc>');
    process.exit(cmd ? 1 : 0);
}
