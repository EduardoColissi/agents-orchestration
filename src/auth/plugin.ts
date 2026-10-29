import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JwtService, Principal, Role } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const PUBLIC_ROUTES = new Set(['/health', '/ready', '/auth/token']);

/** Every route except the public ones requires `Authorization: Bearer <JWT>` (spec FR6). */
export function registerAuth(app: FastifyInstance, jwt: JwtService): void {
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? request.url)) return;
    const header = request.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token) return unauthorized(reply, 'missing bearer token');
    try {
      request.principal = await jwt.verify(token);
    } catch {
      return unauthorized(reply, 'invalid token');
    }
  });
}

/** preHandler: the authenticated principal must have this role (spec FR7). */
export function requireRole(role: Role) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.principal?.role !== role) return reply.code(403).send({ error: 'forbidden', trace_id: request.id });
  };
}

function unauthorized(reply: FastifyReply, details: string) {
  return reply.code(401).header('www-authenticate', 'Bearer error="invalid_token"').send({ error: 'unauthorized', details });
}
