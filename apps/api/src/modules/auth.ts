import { hash, verify } from '@node-rs/argon2';
import { eq, sessions, users } from '@aegis/db';
import {
  AppError,
  SESSION_COOKIE,
  loginSchema,
  registerSchema,
  sha256Hex,
  type UserDto,
} from '@aegis/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
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
    if (!(await rateLimit(ctx.redis, `register:${req.ip}`, 10, 3600))) {
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
    if (!(await rateLimit(ctx.redis, `login:${req.ip}:${body.email}`, 10, 900))) {
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
}
