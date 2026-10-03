import { randomBytes } from 'node:crypto';
import { and, apiKeys, desc, eq, isNull } from '@aegis/db';
import { API_KEY_PREFIX, AppError, createApiKeySchema, randomToken, sha256Hex } from '@aegis/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { audit } from '../core/audit';
import { isUniqueViolation, iso, parse } from '../core/http';
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

/** Create a key; only its hash is stored and the full token is returned exactly once. */
export async function mintApiKey(ctx: AppContext, userId: string, name: string, scopes: string[], expiresAt: Date | null) {
  // 8 hex chars => collisions are rare but possible; retry instead of surfacing a 500
  for (let attempt = 0; attempt < 5; attempt++) {
    const prefix = randomBytes(4).toString('hex');
    const secret = randomToken(24).replace(/_/g, '-'); // keep '_' as the field separator
    try {
      const [row] = await ctx.db.insert(apiKeys).values({ userId, name, prefix, keyHash: sha256Hex(secret), scopes, expiresAt }).returning();
      return { row: row!, token: `${API_KEY_PREFIX}_${prefix}_${secret}` };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AppError(503, 'INTERNAL', 'Could not allocate an API key, please retry');
}

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

    const { row, token } = await mintApiKey(ctx, principal.user.id, body.name, body.scopes, body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null);
    await audit(ctx, req, { action: 'apikey.create', resourceType: 'api_key', resourceId: row.id, metadata: { name: body.name, scopes: body.scopes } });
    // the full key is returned exactly once; only its hash is stored
    return reply.code(201).send({ ...toDto(row), key: token });
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
