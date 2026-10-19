import { describe, expect, it } from 'vitest';
import { parseIncidentJson } from '@timemachine/core';
import { client, mockFetch, requests, token } from './helpers.js';

describe('sanitized failure capture', () => {
  it('creates a valid capture-only Node.js incident and authenticates delivery', async () => {
    const sdk = client({ language: 'typescript' });
    const result = sdk.captureException(new TypeError('password=private-value'), {
      code: 'ORDER_FAILED',
      requestId: 'req-1',
      correlationId: 'trace-1',
    });
    expect(result.queued).toBe(true);
    expect(await sdk.flush()).toBe(true);
    const incident = parseIncidentJson(requests[0]!.body);
    expect(incident).toMatchObject({
      schemaVersion: 1,
      runtime: { language: 'typescript', name: 'node' },
      failure: { name: 'TypeError', code: 'ORDER_FAILED', frames: [] },
      correlation: { requestId: 'req-1', correlationId: 'trace-1' },
      replay: { status: 'unsupported', reason: 'missing-fixtures' },
    });
    expect(requests[0]!.options.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      'x-correlation-id': 'trace-1',
    });
    expect(requests[0]!.options.redirect).toBe('error');
    expect(requests[0]!.body).not.toContain('private-value');
    expect(sdk.getStats()).toMatchObject({ delivered: 1, failed: 0, pending: 0 });
  });

  it('does not inspect thrown object properties or raw stacks', async () => {
    const sdk = client();
    const error = Object.defineProperty({}, 'message', {
      get: () => {
        throw new Error('Never read me');
      },
    });
    expect(sdk.captureException(error).queued).toBe(true);
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('private-prototype');
        },
      },
    );
    expect(sdk.captureException(proxy).queued).toBe(true);
    const native = new Error('private-message');
    Object.defineProperty(native, 'name', {
      get: () => {
        throw new Error('Never read me');
      },
    });
    Object.defineProperty(native, 'stack', {
      get: () => {
        throw new Error('Never read me');
      },
    });
    expect(sdk.captureException(native).queued).toBe(true);
    await sdk.flush();
    expect(requests.every(({ body }) => !body.includes('private-message'))).toBe(true);
  });

  it('captures reviewed HTTP metadata without recording payloads', async () => {
    const sdk = client();
    sdk.captureException(new Error('query-with-credential'), {
      code: 'HTTP_HANDLER_ERROR',
      http: {
        method: 'POST',
        route: '/orders/:orderId',
        statusCode: 503,
        durationMs: 12,
      },
    });
    await sdk.flush();
    const incident = parseIncidentJson(requests[0]!.body);
    expect(incident.timeline).toEqual([
      {
        id: 'event-1',
        type: 'http.request',
        method: 'POST',
        route: '/orders/:orderId',
        offsetMs: 0,
      },
      { id: 'event-2', type: 'error', code: 'HTTP_HANDLER_ERROR', offsetMs: 12 },
      { id: 'event-3', type: 'http.response', statusCode: 503, offsetMs: 12 },
    ]);
    expect(incident.failure.source).toBe('http-handler');
  });

  it.each([
    { requestId: 'forged\nrequest' },
    { correlationId: 'x'.repeat(129) },
    { code: 'token=private' },
    { code: token },
    { http: { method: 'GET' as const, route: '/orders?secret=value' } },
    { http: { method: 'GET' as const, route: '/orders', durationMs: -1 } },
    { http: { method: 'GET' as const, route: '/orders', statusCode: 700 } },
  ])('drops invalid or sensitive context without throwing: %j', async (context) => {
    const sdk = client();
    expect(sdk.captureException(new Error('synthetic'), context)).toEqual({
      queued: false,
      reason: 'invalid-context',
    });
    expect(await sdk.flush()).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(sdk.getStats().dropped).toBe(1);
  });

  it('isolates configuration from later caller mutation and has no process hooks', async () => {
    const service = { name: 'original-app', version: '0.1.0', environment: 'test' };
    const listeners =
      process.listenerCount('uncaughtException') +
      process.listenerCount('unhandledRejection');
    const sdk = client({ service });
    service.name = 'changed';
    sdk.captureException('synthetic');
    await sdk.flush();
    expect(parseIncidentJson(requests[0]!.body).service.name).toBe('original-app');
    expect(
      process.listenerCount('uncaughtException') +
        process.listenerCount('unhandledRejection'),
    ).toBe(listeners);
  });
});

it('separates observed error time and offset from response completion', async () => {
  const sdk = client();
  sdk.captureException(new Error('private'), {
    occurredAt: '2026-01-01T12:00:00.123Z',
    http: {
      method: 'PUT',
      route: '/users/:id',
      durationMs: 50,
      errorOffsetMs: 12,
      statusCode: 500,
    },
  });
  await sdk.flush();
  const incident = parseIncidentJson(requests[0]!.body);
  expect(incident.occurredAt).toBe('2026-01-01T12:00:00.123Z');
  expect(incident.timeline.map((event) => event.offsetMs)).toEqual([0, 12, 50]);
  expect(Date.parse(incident.capturedAt)).toBeGreaterThan(
    Date.parse(incident.occurredAt),
  );
  expect(
    sdk.captureException(undefined, {
      http: { method: 'GET', route: '/users', durationMs: 10, errorOffsetMs: 20 },
    }).queued,
  ).toBe(false);
});

it('delivers a custom application fixture as metadata without customer inputs', async () => {
  const sdk = client({
    service: { name: 'my-api', version: '2.0.0', environment: 'test' },
  });
  const replayFixture = {
    schemaVersion: 1 as const,
    runner: 'express-app-v1' as const,
    artifactId: `sha256:${'a'.repeat(64)}`,
    service: 'my-api',
    profile: 'profile-update',
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
  expect(
    sdk.captureException(new Error('private customer input'), {
      code: 'PROFILE_UPDATE_FAILED',
      replayFixture,
      http: { method: 'PATCH', route: '/profiles/:id', statusCode: 500, durationMs: 3 },
    }).queued,
  ).toBe(true);
  expect(await sdk.flush()).toBe(true);
  const envelope = JSON.parse(requests[0]!.body);
  expect(envelope).toMatchObject({
    captureVersion: 1,
    replayFixture,
    incident: {
      service: { name: 'my-api', version: '2.0.0' },
      replay: { status: 'candidate' },
    },
  });
  expect(requests[0]!.body).not.toContain('private customer input');
  expect(sdk.getStats().delivered).toBe(1);
});

it('delivers ordered dependency events with their required capability', async () => {
  const sdk = client();
  expect(
    sdk.captureException(new Error('private'), {
      http: {
        method: 'POST',
        route: '/checkout',
        durationMs: 20,
        errorOffsetMs: 15,
        statusCode: 500,
      },
      dependencies: [
        {
          dependencyId: 'inventory',
          operation: 'lookup',
          outcome: 'failure',
          durationMs: 8,
          offsetMs: 2,
        },
      ],
    }).queued,
  ).toBe(true);
  await sdk.flush();
  const incident = parseIncidentJson(requests[0]!.body);
  expect(incident.adapter.capabilities.capture).toContain('dependency-metadata');
  expect(incident.timeline.map((event) => event.type)).toEqual([
    'http.request',
    'dependency',
    'error',
    'http.response',
  ]);
});

it('delivers selected recording bodies through the validated incident wire format', async () => {
  const sdk = client();
  expect(
    sdk.captureException(new Error('private'), {
      http: { method: 'POST', route: '/checkout', durationMs: 2, statusCode: 500 },
      recording: {
        version: 1,
        policyId: 'safe-v1',
        request: {
          method: 'POST',
          route: '/checkout',
          body: { quantity: 2 },
          partial: false,
        },
        dependencies: [
          {
            id: 'inventory',
            method: 'GET',
            route: '/check',
            statusCode: 503,
            body: { available: false },
            partial: false,
            result: 'response',
          },
        ],
        truncated: false,
      },
    }).queued,
  ).toBe(true);
  await sdk.flush();
  expect(parseIncidentJson(requests[0]!.body).recording?.dependencies[0]?.body).toEqual({
    available: false,
  });
});

it('delivers source facts linked to the same captured dependency without uploading code', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const root = resolve('../..'),
    file = 'examples/express-delivery/src/app.js';
  const text = readFileSync(resolve(root, file), 'utf8');
  const lines = text.split('\n');
  const positions = ['toFixed', 'calculateFee(await'].map((token) => {
    const line = lines.findIndex((value) => value.includes(token));
    return { line: line + 1, column: lines[line]!.indexOf(token) + 1 };
  });
  const error = new TypeError('private-error-detail');
  Object.defineProperty(error, 'stack', {
    value:
      'TypeError: private-error-detail\n' +
      positions
        .map(
          (position) =>
            `    at calculateFee (${resolve(root, file)}:${position.line}:${position.column})`,
        )
        .join('\n'),
  });
  const sdk = client({ sourceRoot: root, sourceEvidenceFiles: [file] });
  expect(
    sdk.captureException(error, {
      http: { method: 'POST', route: '/delivery/quote', statusCode: 500, durationMs: 2 },
      recording: {
        version: 1,
        policyId: 'delivery-http-v1',
        request: {
          method: 'POST',
          route: '/delivery/quote',
          body: { distanceKm: 10 },
          partial: false,
        },
        dependencies: [
          {
            id: 'pricing',
            method: 'GET',
            origin: 'http://127.0.0.1:4330',
            route: '/rates',
            statusCode: 200,
            body: { ratePerKm: 2, currency: 'USD' },
            partial: false,
            result: 'response',
          },
        ],
        truncated: false,
      },
    }).queued,
  ).toBe(true);
  await sdk.flush();
  const incident = parseIncidentJson(requests[0]!.body);
  expect(incident.failure.sourceAccess).toMatchObject({
    file,
    field: /const RATE_FIELD = '([^']+)'/.exec(text)?.[1],
    operation: 'toFixed',
    dependencyId: 'pricing',
  });
  expect(requests[0]!.body).not.toMatch(
    /private-error-detail|const RATE_FIELD|export function/,
  );
});
