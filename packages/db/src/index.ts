import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export * from './schema';
export { schema };
export * from 'drizzle-orm';

export type Db = ReturnType<typeof createDb>['db'];

// Return BIGINT (int8) columns as JS numbers; object sizes stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
}
