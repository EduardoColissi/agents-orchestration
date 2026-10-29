import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { AppDeps } from './container.js';
import { registerAuth, requireRole } from './auth/plugin.js';
import { ConversationBusyError, ConversationNotFoundError } from './chat/service.js';

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1, 'message must not be empty').max(2000),
  /** Kept for compatibility with the original contract: an assertion, never the identity (FR8). */
  user_id: z.string().trim().min(1).max(64).regex(/^[\w.@-]+$/, 'user_id has invalid characters').optional(),
  /** Omit to start a new conversation; the response returns its id. */
  conversation_id: z.uuid().optional(),
});

const TokenRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.logger as FastifyBaseLogger, bodyLimit: 16 * 1024, genReqId: () => randomUUID() });
  await app.register(rateLimit, { global: false });
  registerAuth(app, deps.jwt);

  app.get('/health', async () => ({ status: 'ok', knowledge_base_chunks: deps.knowledgeBaseSize }));

  // Demo identity provider (spec §3): in production this is the company's OIDC provider.
  app.post('/auth/token', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = TokenRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: z.flattenError(parsed.error).fieldErrors });
    const principal = deps.credentials.verify(parsed.data.username, parsed.data.password);
    if (!principal) {
      deps.audit.write({ actor: parsed.data.username, action: 'auth.login_failed' });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    deps.audit.write({ actor: principal.sub, action: 'auth.token_issued', details: { role: principal.role } });
    return { access_token: await deps.jwt.issue(principal), token_type: 'Bearer', expires_in: deps.jwt.ttlSeconds, sub: principal.sub, role: principal.role };
  });

  app.post('/chat', { preHandler: requireRole('merchant') }, async (request, reply) => {
    const parsed = ChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: z.flattenError(parsed.error).fieldErrors });
    }
    const principal = request.principal!;
    if (parsed.data.user_id !== undefined && parsed.data.user_id !== principal.sub) {
      deps.audit.write({ actor: principal.sub, action: 'auth.user_mismatch', details: { claimed_user_id: parsed.data.user_id } });
      return reply.code(403).send({ error: 'user_mismatch', trace_id: request.id });
    }
    return deps.chat.chat(principal, { message: parsed.data.message, traceId: request.id, ...(parsed.data.conversation_id ? { conversationId: parsed.data.conversation_id } : {}) });
  });

  app.get<{ Params: { id: string } }>('/conversations/:id', { preHandler: requireRole('merchant') }, async (request) => deps.chat.view(request.principal!, request.params.id));

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof ConversationNotFoundError) return reply.code(404).send({ error: 'conversation_not_found', trace_id: request.id });
    if (error instanceof ConversationBusyError) return reply.code(409).send({ error: 'conversation_busy', trace_id: request.id });
    // Malformed JSON, wrong content type, body too large, rate limit…
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.statusCode === 429 ? 'rate_limited' : 'invalid_request', details: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', trace_id: request.id });
  });

  return app;
}
