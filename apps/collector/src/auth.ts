import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export function authenticate(token: string) {
  const expected = createHash('sha256').update(token).digest();
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHORIZED');
    const supplied = createHash('sha256').update(header.slice(7)).digest();
    if (!timingSafeEqual(expected, supplied)) throw new ApiError(401, 'UNAUTHORIZED');
  };
}
