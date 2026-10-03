import type { Db, Pool } from '@aegis/db';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { StorageClient } from '@aegis/nodeclient';

/** Everything the services need; created once in main.ts and passed explicitly (no globals). */
export interface AppContext {
  cfg: Config;
  db: Db;
  pool: Pool;
  redis: Redis | null;
  storage: StorageClient;
  log: FastifyBaseLogger;
}
