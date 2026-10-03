import { hash } from '@node-rs/argon2';
import { eq, users } from '@aegis/db';
import type { AppContext } from './context';

/** Create the initial administrator from ADMIN_EMAIL / ADMIN_PASSWORD on first boot (idempotent). */
export async function ensureAdmin(ctx: AppContext): Promise<void> {
  const { cfg, db, log } = ctx;
  const [existing] = await db.select().from(users).where(eq(users.email, cfg.ADMIN_EMAIL.toLowerCase()));
  if (existing) return;
  await db.insert(users).values({
    email: cfg.ADMIN_EMAIL.toLowerCase(),
    name: 'Administrator',
    passwordHash: await hash(cfg.ADMIN_PASSWORD),
    role: 'ADMIN',
  });
  log.info({ email: cfg.ADMIN_EMAIL }, 'seeded administrator account');
  if (cfg.ADMIN_PASSWORD === 'ChangeMe123!') {
    log.warn('ADMIN_PASSWORD is still the default value - change it in .env before exposing this system');
  }
}
