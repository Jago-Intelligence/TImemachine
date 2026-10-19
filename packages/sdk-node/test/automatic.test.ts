import { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { installAutomaticRecording } from '../src/automatic.js';
import type { TimeMachineClient } from '../src/types.js';

it('observes requests and native fetch without application middleware or live sockets', async () => {
  const originalFetch = globalThis.fetch;
  const originalEmit = Server.prototype.emit;
  globalThis.fetch = vi.fn(
    async () => new Response('private', { status: 503 }),
  ) as typeof fetch;
  const captureException = vi.fn<TimeMachineClient['captureException']>(() => ({
    queued: true,
    incidentId: 'test',
  }));
  const sdk = { captureException } as unknown as TimeMachineClient;
  const instrumentation = installAutomaticRecording(sdk);
  try {
    const server = new Server();
    const response = Object.assign(new EventEmitter(), {
      statusCode: 500,
      headersSent: false,
      writableFinished: false,
      setHeader: vi.fn(),
    }) as unknown as ServerResponse;
    const done = new Promise<void>((resolve) => {
      server.on('request', async (request, response) => {
        Object.assign(request, { route: { path: '/auth/login' } });
        await globalThis.fetch('https://private.example?token=secret');
        Object.assign(response, { writableFinished: true });
        response.emit('finish');
        resolve();
      });
    });
    expect(server.emit('request', { method: 'POST' }, response)).toBe(true);
    await done;
    expect(captureException).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        code: 'HTTP_500',
        http: expect.objectContaining({ route: '/auth/login', method: 'POST' }),
        dependencies: [
          expect.objectContaining({ dependencyId: 'outbound-http', outcome: 'failure' }),
        ],
      }),
    );
    expect(JSON.stringify(captureException.mock.calls)).not.toMatch(/private|secret/);
  } finally {
    instrumentation.restore();
    expect(Server.prototype.emit).toBe(originalEmit);
    globalThis.fetch = originalFetch;
  }
});

it('attaches projected HTTP recording to failures without consuming response bodies', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () =>
    Response.json({ available: false, token: 'private' }, { status: 503 }),
  ) as typeof fetch;
  let capture: (context: Parameters<TimeMachineClient['captureException']>[1]) => void;
  const captured = new Promise<Parameters<TimeMachineClient['captureException']>[1]>(
    (resolve) => {
      capture = (context) => resolve(context);
    },
  );
  const captureException: TimeMachineClient['captureException'] = (_error, context) => {
    capture(context);
    return { queued: true, incidentId: 'test' };
  };
  const instrumentation = installAutomaticRecording(
    { captureException } as TimeMachineClient,
    {
      id: 'safe-v1',
      requests: [{ method: 'POST', route: '/checkout', bodyFields: ['quantity'] }],
      dependencies: [
        {
          id: 'inventory',
          method: 'GET',
          origin: 'https://inventory.example',
          route: '/check',
          responseFields: ['available'],
        },
      ],
    },
  );
  try {
    const server = new Server();
    server.on('request', async (request, response) => {
      Object.assign(request, {
        route: { path: '/checkout' },
        body: { quantity: 2, password: 'private' },
      });
      const reply = await globalThis.fetch(
        'https://inventory.example/check?token=private',
      );
      expect(await reply.json()).toHaveProperty('token', 'private');
      Object.assign(response, { writableFinished: true });
      response.emit('finish');
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 500,
      headersSent: false,
      writableFinished: false,
      setHeader: vi.fn(),
    });
    server.emit('request', { method: 'POST' }, response);
    const context = await captured;
    expect(context?.recording).toMatchObject({
      request: { body: { quantity: 2 }, partial: true },
      dependencies: [
        { id: 'inventory', statusCode: 503, body: { available: false }, partial: true },
      ],
    });
    expect(JSON.stringify(context)).not.toContain('private');
  } finally {
    instrumentation.restore();
    globalThis.fetch = originalFetch;
  }
});

it('keeps concurrent failed request inputs and dependency responses separate', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input) => {
    const quantity = Number(new URL(String(input)).searchParams.get('quantity'));
    await new Promise((resolve) => setTimeout(resolve, quantity === 1 ? 5 : 1));
    return Response.json({ quantity });
  }) as typeof fetch;
  const captures: Array<Parameters<TimeMachineClient['captureException']>[1]> = [];
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const captureException: TimeMachineClient['captureException'] = (_error, context) => {
    captures.push(context);
    if (captures.length === 2) complete();
    return { queued: true, incidentId: 'test' };
  };
  const instrumentation = installAutomaticRecording(
    { captureException } as TimeMachineClient,
    {
      id: 'safe-v1',
      requests: [{ method: 'POST', route: '/checkout', bodyFields: ['quantity'] }],
      dependencies: [
        {
          id: 'inventory',
          method: 'GET',
          origin: 'https://inventory.example',
          route: '/check',
          responseFields: ['quantity'],
        },
      ],
    },
  );
  try {
    const server = new Server();
    server.on('request', async (request, response) => {
      const quantity = (request as unknown as { body: { quantity: number } }).body
        .quantity;
      await globalThis.fetch(`https://inventory.example/check?quantity=${quantity}`);
      Object.assign(response, { writableFinished: true });
      response.emit('finish');
    });
    for (const quantity of [1, 2]) {
      server.emit(
        'request',
        { method: 'POST', route: { path: '/checkout' }, body: { quantity } },
        Object.assign(new EventEmitter(), {
          statusCode: 500,
          headersSent: false,
          writableFinished: false,
          setHeader: vi.fn(),
        }),
      );
    }
    await done;
    expect(new Set(captures.map((context) => context?.requestId)).size).toBe(2);
    for (const context of captures)
      expect(context?.recording?.dependencies[0]?.body.quantity).toBe(
        context?.recording?.request.body.quantity,
      );
  } finally {
    instrumentation.restore();
    globalThis.fetch = originalFetch;
  }
});

it('records complete public browser requests with a reviewed header policy while keeping cookies partial', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () =>
    Response.json(
      { ratePerKm: 2, currency: 'USD' },
      { headers: { 'x-request-id': 'synthetic-correlation' } },
    ),
  ) as typeof fetch;
  const captures: Array<Parameters<TimeMachineClient['captureException']>[1]> = [];
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const captureException: TimeMachineClient['captureException'] = (_error, context) => {
    captures.push(context);
    if (captures.length === 2) complete();
    return { queued: true, incidentId: 'test' };
  };
  const instrumentation = installAutomaticRecording(
    { captureException } as TimeMachineClient,
    {
      id: 'delivery-http-v1',
      artifactId: `sha256:${'a'.repeat(64)}`,
      ignoredRequestHeaders: ['origin', 'sec-fetch-mode'],
      requests: [
        { method: 'POST', route: '/delivery/quote', bodyFields: ['distanceKm'] },
      ],
      dependencies: [
        {
          id: 'pricing',
          method: 'GET',
          origin: 'http://127.0.0.1:4330',
          route: '/rates',
          responseFields: ['ratePerKm', 'currency'],
          ignoredResponseHeaders: ['x-request-id'],
        },
      ],
    },
  );
  try {
    const server = new Server();
    server.on('request', async (_request, response) => {
      await (await globalThis.fetch('http://127.0.0.1:4330/rates')).json();
      Object.assign(response, { writableFinished: true });
      response.emit('finish');
    });
    for (const cookie of [false, true])
      server.emit(
        'request',
        {
          method: 'POST',
          url: '/delivery/quote',
          route: { path: '/delivery/quote' },
          body: { distanceKm: 10 },
          headers: {
            origin: 'http://127.0.0.1:4322',
            'sec-fetch-mode': 'cors',
            ...(cookie ? { cookie: 'private' } : {}),
          },
        },
        Object.assign(new EventEmitter(), {
          statusCode: 500,
          headersSent: false,
          writableFinished: false,
          setHeader: vi.fn(),
        }),
      );
    await done;
    expect(captures.map((context) => context?.recording?.request.partial)).toEqual([
      false,
      true,
    ]);
    expect(captures[0]?.recording?.dependencies[0]?.partial).toBe(false);
    expect(JSON.stringify(captures)).not.toContain('private');
  } finally {
    instrumentation.restore();
    globalThis.fetch = originalFetch;
  }
});
