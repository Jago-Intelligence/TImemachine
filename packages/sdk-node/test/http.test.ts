import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIncidentJson } from '@timemachine/core';
import type { HttpHandler } from '../src/index.js';
import { client, requests } from './helpers.js';

const realFetch = globalThis.fetch;
const servers: Server[] = [];
async function listen(handler: HttpHandler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP test address');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('Node.js HTTP wrapper', () => {
  it.each(['sync', 'async'])(
    'captures %s handler failures and returns a generic response',
    async (mode) => {
      const sdk = client();
      const throwFailure = () => {
        throw new TypeError('private-http-error');
      };
      const handler =
        mode === 'sync'
          ? throwFailure
          : async () => {
              throwFailure();
            };
      const address = await listen(sdk.wrapHttpHandler('/orders/:orderId', handler));
      const response = await realFetch(
        `${address}/orders/private-customer?token=private-query`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer private-header' },
          body: 'private-body',
        },
      );
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal Server Error');
      expect(await sdk.flush()).toBe(true);
      const incident = parseIncidentJson(requests[0]!.body);
      expect(incident.timeline[0]).toMatchObject({
        type: 'http.request',
        method: 'POST',
        route: '/orders/:orderId',
      });
      expect(incident.timeline.at(-1)).toMatchObject({
        type: 'http.response',
        statusCode: 500,
      });
      for (const secret of [
        'private-http-error',
        'private-customer',
        'private-query',
        'private-header',
        'private-body',
      ]) {
        expect(requests[0]!.body).not.toContain(secret);
      }
      expect(sdk.getStats().delivered).toBe(1);
    },
  );

  it('captures returned 5xx responses without an exception', async () => {
    const sdk = client();
    const address = await listen(
      sdk.wrapHttpHandler('/fail', (_request, response) => {
        response.statusCode = 503;
        response.end('Application-specific response');
      }),
    );
    const response = await realFetch(address);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Application-specific response');
    await sdk.flush();
    expect(parseIncidentJson(requests[0]!.body).failure.code).toBe('HTTP_503');
  });

  it('passes successful responses through without capture', async () => {
    const sdk = client();
    const address = await listen(
      sdk.wrapHttpHandler('/ok', (_request, response) => {
        response.end('ok');
      }),
    );
    expect(await (await realFetch(address)).text()).toBe('ok');
    await sdk.flush();
    expect(requests).toHaveLength(0);
  });

  it('captures errors after a completed response once without changing it', async () => {
    const sdk = client();
    const address = await listen(
      sdk.wrapHttpHandler('/late', (_request, response) => {
        response.end('finished');
        throw new Error('late-secret');
      }),
    );
    expect(await (await realFetch(address)).text()).toBe('finished');
    await sdk.flush();
    expect(requests).toHaveLength(1);
    expect(parseIncidentJson(requests[0]!.body).failure.code).toBe('HTTP_HANDLER_ERROR');
  });

  it('separates request correlation for concurrent failures', async () => {
    const sdk = client();
    const address = await listen(
      sdk.wrapHttpHandler('/fail', () => {
        throw new Error('synthetic');
      }),
    );
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const response = await realFetch(address);
        await response.text();
      }),
    );
    await sdk.flush();
    expect(
      new Set(requests.map(({ body }) => parseIncidentJson(body).correlation.requestId))
        .size,
    ).toBe(4);
  });

  it('never forwards collector credentials across a redirect', async () => {
    vi.stubGlobal('fetch', realFetch);
    let forwarded = 0;
    const target = await listen((_request, response) => {
      forwarded++;
      response.end('{}');
    });
    const source = await listen((request, response) => {
      request.resume();
      response.statusCode = 307;
      response.setHeader('location', target);
      response.end();
    });
    const sdk = client({ collectorUrl: source, maxRetries: 0 });
    sdk.captureException('synthetic');
    expect(await sdk.flush()).toBe(true);
    expect(sdk.getStats()).toMatchObject({ failed: 1, delivered: 0 });
    expect(forwarded).toBe(0);
  });

  it('times out a collector that stalls after sending response headers', async () => {
    vi.stubGlobal('fetch', realFetch);
    const source = await listen((request, response) => {
      request.resume();
      response.writeHead(201, { 'content-type': 'application/json' });
      response.write('{');
    });
    const sdk = client({ collectorUrl: source, requestTimeoutMs: 30, maxRetries: 0 });
    sdk.captureException('synthetic');
    expect(await sdk.flush({ timeoutMs: 1000 })).toBe(true);
    expect(sdk.getStats()).toMatchObject({ failed: 1, pending: 0 });
  });

  it.each(['/fail?token=value', 'https://example.test/fail', '/fail#value'])(
    'rejects raw URLs when registering a route %s',
    (route) => {
      expect(() => client().wrapHttpHandler(route, () => {})).toThrow(
        'Use a sanitized HTTP route template',
      );
    },
  );
});
