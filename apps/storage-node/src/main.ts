import { BlobStore } from './blobstore';
import { loadConfig } from './config';
import { startHeartbeat } from './heartbeat';
import { MetricsCollector } from './metrics';
import { buildServer } from './server';
import { Chaos } from './chaos';

const cfg = loadConfig();
const store = new BlobStore(cfg.DATA_DIR, cfg.NODE_CAPACITY_BYTES);
await store.init();
const metrics = new MetricsCollector();
const chaos = new Chaos();

const app = await buildServer({
  store,
  metrics,
  secret: cfg.NODE_SHARED_SECRET,
  nodeName: cfg.NODE_NAME,
  logLevel: cfg.LOG_LEVEL,
  chaos,
});

await app.listen({ port: cfg.PORT, host: cfg.HOST });
app.log.info({ blobs: store.blobCount, usedBytes: store.usedBytes, dir: cfg.DATA_DIR }, 'storage node ready');

const stopHeartbeat = startHeartbeat(cfg, store, metrics, {
  warn: (o, m) => app.log.warn(o as object, m),
  info: (m) => app.log.info(m),
}, chaos);
const cleanupTimer = setInterval(() => void store.cleanStaleTmp(), 10 * 60 * 1000);

const shutdown = async () => {
  stopHeartbeat();
  clearInterval(cleanupTimer);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
