import { and, apiKeys, eq, gt, isNull, or, sessions, sql, users } from '@aegis/db';
import {
  API_KEY_PREFIX,
  AppError,
  SESSION_COOKIE,
  randomToken,
  safeEqualHex,
  sha256Hex,
  type Permission,
  type UserRole,
} from '@aegis/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { maxScope } from '../core/authz';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  createdAt: Date;
}

export interface Principal {
  kind: 'USER' | 'API_KEY';
  user: SessionUser;
  apiKeyId?: string;
  /** upper bound on bucket permission (sessions: ADMIN; API keys: from scopes) */
  cap: Permission;
  viaCookie: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TOUCH_INTERVAL_MS = 60_000;

export const newSessionToken = () => randomToken(32);

export async function createSession(ctx: AppContext, userId: string, req: FastifyRequest) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + ctx.cfg.SESSION_TTL_DAYS * 86_400_000);
  await ctx.db.insert(sessions).values({
    userId,
    tokenHash: sha256Hex(token),
    expiresAt,
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

async function userFromApiKey(ctx: AppContext, token: string): Promise<Principal | null> {
  // aegis_<8-char prefix>_<secret>
  const [brand, prefix, secret] = token.split('_');
  if (brand !== API_KEY_PREFIX || !prefix || !secret) return null;
  const [row] = await ctx.db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(
      and(
        eq(apiKeys.prefix, prefix),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`)),
      ),
    );
  if (!row || row.user.status !== 'ACTIVE' || !safeEqualHex(sha256Hex(secret), row.key.keyHash)) return null;
  if (!row.key.lastUsedAt || Date.now() - row.key.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    void ctx.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.key.id)).catch(() => undefined);
  }
  return {
    kind: 'API_KEY',
    user: row.user,
    apiKeyId: row.key.id,
    cap: maxScope(row.key.scopes),
    viaCookie: false,
  };
}

async function userFromSession(ctx: AppContext, token: string): Promise<Principal | null> {
  const [row] = await ctx.db
    .select({ s: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, sql`now()`)));
  if (!row || row.user.status !== 'ACTIVE') return null;
  if (Date.now() - row.s.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    void ctx.db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, row.s.id)).catch(() => undefined);
  }
  return { kind: 'USER', user: row.user, cap: 'ADMIN', viaCookie: true };
}

/** Cookie-authenticated, state-changing requests must come from our own origin (CSRF defence). */
function originAllowed(ctx: AppContext, req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, scripts) send no Origin
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || ctx.cfg.allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

export function registerAuth(app: FastifyInstance, ctx: AppContext) {
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/internal/')) return; // authenticated by shared secret instead

    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const principal = await userFromApiKey(ctx, header.slice(7).trim());
      if (!principal) throw AppError.unauthenticated('Invalid or revoked API key');
      req.principal = principal;
      return;
    }

    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie) {
      const principal = await userFromSession(ctx, cookie);
      if (principal) {
        if (UNSAFE.has(req.method) && !originAllowed(ctx, req)) {
          throw AppError.forbidden('Cross-origin request blocked');
        }
        req.principal = principal;
      }
    }
  });
}

export function requireUser(req: FastifyRequest): Principal {
  if (!req.principal) throw AppError.unauthenticated();
  return req.principal;
}

/** Site-wide administrator (role ADMIN, and an admin-scoped key if using an API key). */
export function requireSiteAdmin(req: FastifyRequest): Principal {
  const p = requireUser(req);
  if (p.user.role !== 'ADMIN' || p.cap !== 'ADMIN') throw AppError.forbidden('Administrator access required');
  return p;
}
