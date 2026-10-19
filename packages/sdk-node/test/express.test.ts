import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { TimeMachineClient } from '../src/types.js';
import { createExpressInstrumentation, type ExpressRequest } from '../src/express.js';

function setup(method = 'GET', options = {}) {
  const captureException = vi.fn<TimeMachineClient['captureException']>(() => ({
    queued: true as const,
    incidentId: 'test',
  }));
  const tm = createExpressInstrumentation({ captureException }, options);
  const request = {
    method,
    route: { path: '/users/:id' },
    url: '/users/secret?token=private',
    body: { password: 'private' },
  } as unknown as ExpressRequest;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 500,
    writableFinished: false,
    headersSent: false,
    setHeader: vi.fn(),
  }) as unknown as ServerResponse;
  tm.middleware(request, response, vi.fn());
  return { tm, request, response, captureException };
}
it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'])(
  'captures a failed %s response without raw request data',
  (method) => {
    const state = setup(method);
    Object.assign(state.response, { writableFinished: true });
    state.response.emit('finish');
    expect(state.captureException).toHaveBeenCalledOnce();
    const context = state.captureException.mock.calls[0]?.[1];
    expect(context).toMatchObject({
      code: 'HTTP_500',
      http: { method, route: '/users/:id', statusCode: 500 },
    });
    expect(JSON.stringify(context)).not.toMatch(/secret|private|password|token/);
  },
);
it('ignores successful and default client error responses', () => {
  for (const status of [200, 201, 204, 302, 400, 404, 429]) {
    const state = setup();
    state.response.statusCode = status;
    Object.assign(state.response, { writableFinished: true });
    state.response.emit('finish');
    expect(state.captureException).not.toHaveBeenCalled();
  }
});
it('supports opt-in client failures and safe unmatched route fallback', () => {
  const state = setup('POST', { captureClientErrors: true });
  delete state.request.route;
  state.response.statusCode = 400;
  Object.assign(state.response, { writableFinished: true });
  state.response.emit('finish');
  expect(state.captureException).toHaveBeenCalledWith(
    undefined,
    expect.objectContaining({
      http: expect.objectContaining({ route: '/:unmatched', statusCode: 400 }),
    }),
  );
});
it('keeps concurrent request context separate and avoids duplicate explicit capture', () => {
  const first = setup();
  const second = setup();
  expect(first.tm.getRequestId(first.request)).not.toBe(
    second.tm.getRequestId(second.request),
  );
  first.tm.captureException(first.request, first.response, new Error('private'), {
    code: 'APP_FAILED',
  });
  Object.assign(first.response, { writableFinished: true });
  first.response.emit('finish');
  first.response.emit('close');
  expect(first.captureException).toHaveBeenCalledOnce();
});
it('observes errors without changing the application error response', () => {
  const state = setup();
  const error = new Error('private');
  const next = vi.fn();
  state.tm.errorHandler(error, state.request, state.response, next);
  expect(next).toHaveBeenCalledWith(error);
  expect(state.captureException).not.toHaveBeenCalled();
  Object.assign(state.response, { writableFinished: true });
  state.response.emit('finish');
  expect(state.captureException).toHaveBeenCalledWith(error, expect.anything());
});
it('captures premature response close once without claiming a completed status', () => {
  const state = setup();
  state.response.emit('close');
  state.response.emit('finish');
  expect(state.captureException).toHaveBeenCalledOnce();
  expect(state.captureException.mock.calls[0]?.[1]).toMatchObject({
    code: 'HTTP_REQUEST_ABORTED',
  });
});
it('keeps two overlapping requests separate within one integration', () => {
  const first = setup('POST');
  const second = setup('PATCH');
  first.tm.middleware(second.request, second.response, vi.fn());
  first.tm.route('/teams/:id/orders')(second.request, second.response, vi.fn());
  Object.assign(second.response, { writableFinished: true });
  second.response.emit('finish');
  Object.assign(first.response, { writableFinished: true });
  first.response.emit('finish');
  const calls = first.captureException.mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[1]).toMatchObject({
    http: { method: 'PATCH', route: '/teams/:id/orders' },
  });
  expect(calls[1]?.[1]).toMatchObject({ http: { method: 'POST', route: '/users/:id' } });
  expect(calls[0]?.[1]?.requestId).not.toBe(calls[1]?.[1]?.requestId);
});
it('retries automatic capture if an explicit context was rejected', () => {
  const state = setup();
  state.captureException.mockReturnValueOnce({
    queued: false,
    reason: 'invalid-context',
  });
  state.tm.captureException(state.request, state.response, undefined, {
    code: 'unsafe code',
  });
  Object.assign(state.response, { writableFinished: true });
  state.response.emit('finish');
  expect(state.captureException).toHaveBeenCalledTimes(2);
  expect(state.captureException.mock.calls[1]?.[1]?.code).toBe('HTTP_500');
});

it('attaches a reviewed custom replay scenario only to a matching failed request', () => {
  const state = setup('PATCH');
  const fixture = {
    schemaVersion: 1 as const,
    runner: 'express-app-v1' as const,
    artifactId: `sha256:${'a'.repeat(64)}`,
    service: 'my-api',
    profile: 'rename-v1',
    scenarioVersion: 'v1',
    method: 'PATCH' as const,
    route: '/profiles/:id',
    failureCode: 'PROFILE_UPDATE_FAILED',
    contractHash: 'a'.repeat(64),
    target: {
      statusCode: 200,
      errorCode: null,
      outcome: 'scenario-assertions-passed' as const,
    },
  };
  state.tm.replay(fixture)(state.request, state.response, vi.fn());
  Object.assign(state.response, { writableFinished: true });
  state.response.emit('finish');
  expect(state.captureException).toHaveBeenCalledWith(
    undefined,
    expect.objectContaining({
      code: 'PROFILE_UPDATE_FAILED',
      replayFixture: fixture,
      http: expect.objectContaining({ route: '/profiles/:id' }),
    }),
  );
  const rejected = setup('PATCH');
  rejected.tm.replay(fixture)(rejected.request, rejected.response, vi.fn());
  Object.assign(rejected.response, { writableFinished: true, statusCode: 401 });
  rejected.response.emit('finish');
  expect(rejected.captureException).not.toHaveBeenCalled();
});

it('records fetch dependencies in request scope without URLs or payloads', async () => {
  const captureException = vi.fn<TimeMachineClient['captureException']>(() => ({
    queued: true,
    incidentId: 'test',
  }));
  const tm = createExpressInstrumentation({ captureException });
  const outbound = tm.fetch(
    'inventory',
    'lookup',
    vi.fn(async () => new Response('secret', { status: 503 })) as typeof fetch,
  );
  const request = { method: 'POST', route: { path: '/checkout' } } as ExpressRequest;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 500,
    writableFinished: false,
    headersSent: false,
    setHeader: vi.fn(),
  }) as unknown as ServerResponse;
  await new Promise<void>((resolve) => {
    tm.middleware(request, response, () => {
      void outbound('https://private.example?token=secret').then(() => {
        Object.assign(response, { writableFinished: true });
        response.emit('finish');
        resolve();
      });
    });
  });
  expect(captureException.mock.calls[0]?.[1]?.dependencies).toMatchObject([
    { dependencyId: 'inventory', operation: 'lookup', outcome: 'failure' },
  ]);
  expect(JSON.stringify(captureException.mock.calls)).not.toContain('secret');
});

it('attaches completed PostgreSQL observations to the correct failed Express request', async () => {
  const { observePostgresQuery } = await import('../src/postgres.js');
  const captureException = vi.fn<TimeMachineClient['captureException']>(() => ({
    queued: true,
    incidentId: 'test',
  }));
  const policy = {
    id: 'zone-v1',
    requests: [
      {
        method: 'POST' as const,
        route: '/delivery/zone-quote',
        bodyFields: ['distanceKm', 'zoneCode'],
      },
    ],
    dependencies: [],
    postgres: [
      {
        id: 'zone-rate',
        text: 'SELECT rate_per_km FROM delivery_zones WHERE zone_code = $1',
        parameterFields: ['zoneCode'],
        rowFields: ['rate_per_km'],
      },
    ],
  };
  const tm = createExpressInstrumentation(
    { captureException },
    { recordingPolicy: policy },
  );
  const request = {
    method: 'POST',
    route: { path: '/delivery/zone-quote' },
    body: { distanceKm: 10, zoneCode: 'LOCAL' },
  } as unknown as ExpressRequest;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 500,
    headersSent: false,
    writableFinished: false,
    setHeader: vi.fn(),
  }) as unknown as ServerResponse;
  await new Promise<void>((resolve) => {
    tm.middleware(request, response, () => {
      void Promise.resolve(
        observePostgresQuery(
          async () => ({ rows: [{ rate_per_km: 2 }], rowCount: 1, command: 'SELECT' }),
          {},
          [policy.postgres[0]!.text, ['LOCAL']],
          tm.getPostgresScope(),
          policy.postgres,
        ),
      ).then(() => {
        Object.assign(response, { writableFinished: true });
        response.emit('finish');
        resolve();
      });
    });
  });
  const context = captureException.mock.calls[0]?.[1];
  expect(context?.recording?.postgres?.[0]).toMatchObject({
    parameters: ['LOCAL'],
    rows: [{ rate_per_km: 2 }],
    partial: false,
  });
  expect(context?.dependencies).toMatchObject([
    { dependencyId: 'zone-rate', operation: 'query', outcome: 'success' },
  ]);
});

it('marks explicitly reviewed synthetic-database routes without recording production database state', () => {
  const state = setup('POST', {
    recordingPolicy: {
      id: 'test',
      requests: [
        {
          method: 'POST',
          route: '/users/:id',
          bodyFields: ['handle'],
          databaseMode: 'synthetic-postgres',
        },
      ],
      dependencies: [],
    },
  });
  Object.assign(state.request, {
    url: '/users/test',
    body: { handle: 'tm-test-one' },
    headers: {},
  });
  Object.assign(state.response, { writableFinished: true });
  state.response.emit('finish');
  expect(state.captureException.mock.calls[0]?.[1]?.recording).toMatchObject({
    databaseMode: 'synthetic-postgres',
    truncated: false,
    request: { body: { handle: 'tm-test-one' }, partial: false },
  });
});

it('attaches wrapped dependency operations to the failed request recording', async () => {
  const captureException = vi.fn<TimeMachineClient['captureException']>(() => ({
    queued: true,
    incidentId: 'test',
  }));
  const tm = createExpressInstrumentation(
    { captureException },
    {
      recordingPolicy: {
        id: 'clients',
        artifactId: `sha256:${'a'.repeat(64)}`,
        requests: [{ method: 'POST', route: '/quote', bodyFields: ['sku'] }],
        dependencies: [],
        operations: [
          {
            id: 'price',
            kind: 'mysql',
            operation: 'execute',
            selector: 'SELECT price FROM products WHERE sku = ?',
            inputFields: ['sku'],
            resultFields: ['price'],
          },
        ],
      },
    },
  );
  const request = {
    method: 'POST',
    route: { path: '/quote' },
    url: '/quote',
    body: { sku: 'MUG' },
  } as unknown as ExpressRequest;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 500,
    writableFinished: false,
    headersSent: false,
    setHeader: vi.fn(),
  }) as unknown as ServerResponse;
  let work: Promise<unknown> | undefined;
  tm.middleware(request, response, () => {
    work = tm.clients
      .mysql({
        execute: async (...args: unknown[]) => (
          void args,
          [[{ price: 2 }], [{ name: 'price' }]]
        ),
      })
      .execute('SELECT price FROM products WHERE sku = ?', ['MUG']);
  });
  await work;
  Object.assign(response, { writableFinished: true });
  response.emit('finish');
  await vi.waitFor(() => expect(captureException).toHaveBeenCalledOnce());
  expect(captureException.mock.calls[0]?.[1]?.recording).toMatchObject({
    operations: [
      {
        kind: 'mysql',
        partial: false,
        input: { sku: 'MUG' },
        inputOrder: ['sku'],
        rows: [{ price: 2 }],
      },
    ],
  });
});
