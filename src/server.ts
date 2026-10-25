import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from './container.js';

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1, 'message must not be empty').max(2000),
  user_id: z.string().trim().min(1).max(64).regex(/^[\w.@-]+$/, 'user_id has invalid characters'),
});

export function buildServer(deps: AppDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger as FastifyBaseLogger, bodyLimit: 16 * 1024, genReqId: () => randomUUID() });

  app.get('/health', async () => ({ status: 'ok', knowledge_base_chunks: deps.knowledgeBaseSize }));

  app.post('/chat', async (request, reply) => {
    const parsed = ChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: z.flattenError(parsed.error).fieldErrors });
    }
    return deps.orchestrator.handle({ message: parsed.data.message, userId: parsed.data.user_id, traceId: request.id });
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    // Malformed JSON, wrong content type, body too large…
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'invalid_request', details: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', trace_id: request.id });
  });

  return app;
}
