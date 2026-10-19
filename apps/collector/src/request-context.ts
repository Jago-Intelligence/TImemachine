import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

export function installRequestContext(app: FastifyInstance): void {
  app.decorateRequest('correlationId', '');
  app.addHook('onRequest', async (request, reply) => {
    const supplied = request.headers['x-correlation-id'];
    request.correlationId = request.id;
    const valid =
      typeof supplied === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(supplied);
    if (valid) request.correlationId = supplied;
    request.log = request.log.child({ correlationId: request.correlationId });
    reply.header('x-request-id', request.id);
    reply.header('x-correlation-id', request.correlationId);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (supplied !== undefined && !valid)
      throw new ApiError(400, 'INVALID_CORRELATION_ID');
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'Collector request completed',
    );
  });
}

export function requestId(): string {
  return randomUUID();
}
