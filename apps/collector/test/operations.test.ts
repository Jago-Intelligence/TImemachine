import { afterEach, describe, expect, it } from 'vitest';
import { parseServerConfig } from '@timemachine/config';
import { createCollector } from '../src/server.js';
import { fixture, headers, memoryStore, testCollector } from './helpers.js';

const running: Awaited<ReturnType<typeof testCollector>>[] = [];
async function setup(env: Record<string, string> = {}, store = memoryStore()) {
  const collector = await testCollector(env, store);
  running.push(collector);
  return collector;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map(({ shutdown }) => shutdown()));
});

describe('collector operations', () => {
  it('requires a token even on loopback', async () => {
    await expect(
      createCollector({ config: parseServerConfig({}), store: memoryStore() }),
    ).rejects.toThrow('TIMEMACHINE_AUTH_TOKEN');
  });

  it('serves public health with minimal information', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/health/live' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ url: '/health/ready' })).json()).toEqual({
      status: 'ready',
    });
  });

  it('keeps liveness available when storage fails readiness', async () => {
    const store = memoryStore();
    store.isReady = async () => {
      throw new Error('private-database-credential');
    };
    const { app, logs } = await setup({}, store);
    const ready = await app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not-ready' });
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
    expect(logs.join('')).not.toContain('private-database-credential');
  });

  it('generates request IDs and accepts validated correlation', async () => {
    const { app, logs } = await setup();
    const response = await app.inject({
      url: '/health/live',
      headers: {
        'x-request-id': 'untrusted-request-id',
        'x-correlation-id': 'trace-123',
      },
    });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-request-id']).not.toBe('untrusted-request-id');
    expect(response.headers['x-correlation-id']).toBe('trace-123');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        requestId: response.headers['x-request-id'],
        correlationId: 'trace-123',
        route: '/health/live',
      }),
    );
  });

  it.each(['invalid correlation', 'x'.repeat(129), 'invalid/token'])(
    'rejects invalid correlation ID: %s',
    async (correlation) => {
      const { app, logs } = await setup();
      const response = await app.inject({
        url: '/health/live',
        headers: { 'x-correlation-id': correlation },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_CORRELATION_ID');
      expect(response.body + logs.join('')).not.toContain(correlation);
    },
  );

  it('rate limits unauthorized requests while exempting health probes', async () => {
    const { app } = await setup({ RATE_LIMIT_MAX: '2' });
    for (let index = 0; index < 3; index++) {
      expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
    }
    const request = {
      method: 'POST' as const,
      url: '/v1/incidents',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    };
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject(request)).statusCode).toBe(401);
    const limited = await app.inject(request);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
  });

  it('does not trust forwarded IPs to bypass the limiter', async () => {
    const { app } = await setup({ RATE_LIMIT_MAX: '1' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers: { ...headers, 'x-forwarded-for': '192.0.2.1' },
          payload: fixture(),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers: { ...headers, 'x-forwarded-for': '192.0.2.2' },
          payload: fixture(),
        })
      ).statusCode,
    ).toBe(429);
  });

  it.each([
    ['/v1/incidents/%broken?token=synthetic-router-secret', 400],
    ['/v1/incidents/' + 'synthetic-router-secret'.repeat(10), 414],
  ])('sanitizes early router failures for %s', async (url, status) => {
    const { app, logs } = await setup();
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({
      apiVersion: 1,
      error: { code: 'INVALID_REQUEST', requestId: response.headers['x-request-id'] },
    });
    expect(response.headers['x-correlation-id']).toBe(response.headers['x-request-id']);
    expect(response.body + logs.join('')).not.toContain('synthetic-router-secret');
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        requestId: response.headers['x-request-id'],
        correlationId: response.headers['x-correlation-id'],
      }),
    );
  });

  it('hides unexpected internal errors and sensitive request URLs in logs', async () => {
    const store = memoryStore();
    store.save = async () => {
      throw new Error('private-storage-password');
    };
    const { app, logs } = await setup({}, store);
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/incidents?token=private-url-token',
      headers,
      payload: fixture(),
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.code).toBe('INTERNAL_ERROR');
    const missing = await app.inject({
      url: '/private-path-secret?token=private-url-token',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    for (const secret of [
      'private-storage-password',
      'private-path-secret',
      'private-url-token',
    ]) {
      expect(failed.body + missing.body + logs.join('')).not.toContain(secret);
    }
  });
});
