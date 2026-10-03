import { hash, verify } from '@node-rs/argon2';
import { and, desc, eq, gt, ne, sessions, sql, users } from '@aegis/db';
import {
  AppError,
  SESSION_COOKIE,
  changePasswordSchema,
  loginSchema,
  registerSchema,
  sha256Hex,
  type UserDto,
} from '@aegis/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { audit } from '../core/audit';
import { iso, isUniqueViolation, parse } from '../core/http';
import { rateLimit } from '../core/redis';
import { createSession, requireUser, type SessionUser } from '../plugins/auth';

export const toUserDto = (u: SessionUser): UserDto => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: iso(u.createdAt)!,
});

// verifying against this when the email is unknown keeps login timing uniform
let dummyHash: string | null = null;

function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.cfg.COOKIE_SECURE,
    path: '/',
    expires: expiresAt,
  });
}

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/api/auth/register', async (req, reply) => {
    if (!(await rateLimit(ctx.redis, `register:${req.ip}`, ctx.cfg.REGISTER_RATE_LIMIT, 3600))) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many registrations from this address');
    }
    const body = parse(registerSchema, req.body);
    let user: SessionUser;
    try {
      const [row] = await ctx.db
        .insert(users)
        .values({ email: body.email, name: body.name ?? null, passwordHash: await hash(body.password), role: 'MEMBER' })
        .returning();
      user = row!;
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict('An account with this email already exists');
      throw err;
    }
    const { token, expiresAt } = await createSession(ctx, user.id, req);
    setSessionCookie(ctx, reply, token, expiresAt);
    await audit(ctx, null, {
      action: 'auth.register',
      resourceType: 'user',
      resourceId: user.id,
      actor: { id: user.id, type: 'USER', label: user.email },
    });
    return reply.code(201).send({ user: toUserDto(user) });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(loginSchema, req.body);
    // per IP+email stops brute force on one account; the per-IP cap stops spraying across accounts
    const allowed =
      (await rateLimit(ctx.redis, `login:${req.ip}:${body.email}`, ctx.cfg.LOGIN_RATE_LIMIT, 900)) &&
      (await rateLimit(ctx.redis, `login-ip:${req.ip}`, ctx.cfg.LOGIN_RATE_LIMIT * 5, 900));
    if (!allowed) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many login attempts, try again in a few minutes');
    }
    const [user] = await ctx.db.select().from(users).where(eq(users.email, body.email));
    dummyHash ??= await hash('aegis-dummy-password');
    const ok = await verify(user?.passwordHash ?? dummyHash, body.password).catch(() => false);
    if (!user || !ok || user.status !== 'ACTIVE') {
      await audit(ctx, req, {
        action: 'auth.login_failed',
        resourceType: 'user',
        metadata: { email: body.email },
        actor: { id: user?.id ?? null, type: 'ANONYMOUS', label: body.email },
      });
      throw AppError.unauthenticated('Invalid email or password');
    }
    await ctx.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    const { token, expiresAt } = await createSession(ctx, user.id, req);
    setSessionCookie(ctx, reply, token, expiresAt);
    await audit(ctx, null, {
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      actor: { id: user.id, type: 'USER', label: user.email },
    });
    return { user: toUserDto(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await ctx.db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
    if (req.principal) await audit(ctx, req, { action: 'auth.logout', resourceType: 'user', resourceId: req.principal.user.id });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: toUserDto(requireUser(req).user) }));

  const currentSessionHash = (req: FastifyRequest) => {
    const token = req.cookies[SESSION_COOKIE];
    return token ? sha256Hex(token) : null;
  };
  const requireSession = (req: FastifyRequest) => {
    const p = requireUser(req);
    // credential management needs an interactive session; a leaked API key must not escalate
    if (p.kind !== 'USER') throw AppError.forbidden('Sign in with your password to manage credentials');
    return p;
  };

  app.post('/api/auth/password', async (req) => {
    const { user } = requireSession(req);
    const body = parse(changePasswordSchema, req.body);
    if (!(await rateLimit(ctx.redis, `pwchange:${user.id}`, 10, 900))) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many attempts, try again later');
    }
    const [row] = await ctx.db.select().from(users).where(eq(users.id, user.id));
    if (!row || !(await verify(row.passwordHash, body.currentPassword).catch(() => false))) {
      await audit(ctx, req, { action: 'auth.password_change_failed', resourceType: 'user', resourceId: user.id });
      throw AppError.validation('Current password is incorrect');
    }
    await ctx.db.update(users).set({ passwordHash: await hash(body.newPassword) }).where(eq(users.id, user.id));
    // every other session is signed out; the current one stays
    const keep = currentSessionHash(req);
    const revoked = await ctx.db
      .delete(sessions)
      .where(keep ? and(eq(sessions.userId, user.id), ne(sessions.tokenHash, keep)) : eq(sessions.userId, user.id))
      .returning({ id: sessions.id });
    await audit(ctx, req, { action: 'auth.password_change', resourceType: 'user', resourceId: user.id, metadata: { revokedSessions: revoked.length } });
    return { ok: true, revokedSessions: revoked.length };
  });

  app.get('/api/auth/sessions', async (req) => {
    const { user } = requireSession(req);
    const current = currentSessionHash(req);
    const rows = await ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, sql`now()`)))
      .orderBy(desc(sessions.lastUsedAt));
    return {
      items: rows.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: iso(s.createdAt),
        lastUsedAt: iso(s.lastUsedAt),
        expiresAt: iso(s.expiresAt),
        current: s.tokenHash === current,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req) => {
    const { user } = requireSession(req);
    const deleted = await ctx.db
      .delete(sessions)
      .where(and(eq(sessions.id, req.params.id), eq(sessions.userId, user.id)))
      .returning({ id: sessions.id });
    if (!deleted.length) throw AppError.notFound('Session not found');
    await audit(ctx, req, { action: 'auth.session_revoke', resourceType: 'session', resourceId: req.params.id });
    return { ok: true };
  });
}
