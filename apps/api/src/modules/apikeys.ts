import { randomBytes } from 'node:crypto';
import { and, apiKeys, desc, eq, isNull } from '@aegis/db';
import { API_KEY_PREFIX, AppError, createApiKeySchema, randomToken, sha256Hex } from '@aegis/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { audit } from '../core/audit';
import { iso, parse } from '../core/http';
import { requireUser } from '../plugins/auth';

const toDto = (k: typeof apiKeys.$inferSelect) => ({
  id: k.id,
  name: k.name,
  prefix: `${API_KEY_PREFIX}_${k.prefix}`,
  scopes: k.scopes,
  lastUsedAt: iso(k.lastUsedAt),
  expiresAt: iso(k.expiresAt),
  revokedAt: iso(k.revokedAt),
  createdAt: iso(k.createdAt)!,
});

export function apiKeyRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/api-keys', async (req) => {
    const { user } = requireUser(req);
    const rows = await ctx.db.select().from(apiKeys).where(eq(apiKeys.userId, user.id)).orderBy(desc(apiKeys.createdAt));
    return { items: rows.map(toDto) };
  });

  app.post('/api/api-keys', async (req, reply) => {
    const principal = requireUser(req);
    // keys cannot mint new keys: a leaked key must not be able to persist itself
    if (principal.kind === 'API_KEY') throw AppError.forbidden('API keys cannot create API keys');
    const body = parse(createApiKeySchema, req.body);

    const prefix = randomBytes(4).toString('hex'); // 8 hex chars, unique-indexed
    const secret = randomToken(24).replace(/_/g, '-'); // keep '_' as the field separator
    const [row] = await ctx.db
      .insert(apiKeys)
      .values({
        userId: principal.user.id,
        name: body.name,
        prefix,
        keyHash: sha256Hex(secret),
        scopes: body.scopes,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null,
      })
      .returning();
    await audit(ctx, req, { action: 'apikey.create', resourceType: 'api_key', resourceId: row!.id, metadata: { name: body.name, scopes: body.scopes } });
    // the full key is returned exactly once; only its hash is stored
    return reply.code(201).send({ ...toDto(row!), key: `${API_KEY_PREFIX}_${prefix}_${secret}` });
  });

  app.delete<{ Params: { id: string } }>('/api/api-keys/:id', async (req) => {
    const { user } = requireUser(req);
    const [row] = await ctx.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)))
      .returning();
    if (!row) throw AppError.notFound('API key not found');
    await audit(ctx, req, { action: 'apikey.revoke', resourceType: 'api_key', resourceId: row.id, metadata: { name: row.name } });
    return { ok: true };
  });
}
