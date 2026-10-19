import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { parseServerConfig } from '@timemachine/config';
import { createMemoryStore } from '@timemachine/storage';
import { ReplayExecutionError, type ReplayExecutor } from '@timemachine/replay';
import type { ReplayFixture } from '@timemachine/core';
import { createCollector } from '../src/server.js';
import { fixture, headers, token } from './helpers.js';
const image = `sha256:${'a'.repeat(64)}`;
const running: Awaited<ReturnType<typeof createCollector>>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(({ shutdown }) => shutdown()));
});
async function setup(
  executor?: ReplayExecutor,
  baselineStatus = 500,
  profile: 'orders-create-v1' | 'auth-case-normalization-v1' = 'orders-create-v1',
) {
  const store = createMemoryStore({
    maxEntries: 100,
    maxBytes: 1024 * 1024,
    retentionMs: 60000,
  });
  const replayExecutor: ReplayExecutor = executor ?? {
    run: async () => ({
      statusCode: 500,
      errorCode: 'ORDER_CREATION_FAILED',
      runtimeVersion: '24.3.0',
      timeline: [
        {
          id: 'request',
          offsetMs: 0,
          type: 'http.request',
          method: 'POST',
          route: '/orders',
        },
        { id: 'error', offsetMs: 1, type: 'error', code: 'ORDER_CREATION_FAILED' },
        { id: 'response', offsetMs: 1, type: 'http.response', statusCode: 500 },
      ],
    }),
    close: async () => {},
  };
  const collector = await createCollector({
    store,
    replayExecutor,
    config: parseServerConfig({
      NODE_ENV: 'test',
      TIMEMACHINE_AUTH_TOKEN: token,
      REPLAY_IMAGE_ID: image,
      LOG_LEVEL: 'silent',
    }),
  });
  running.push(collector);
  const incident = fixture();
  incident.id = randomUUID();
  incident.service.name = 'express-orders';
  incident.failure.code =
    profile === 'auth-case-normalization-v1'
      ? 'AUTH_LOGIN_FAILED'
      : 'ORDER_CREATION_FAILED';
  incident.replay = {
    status: 'candidate',
    mode: 'node-http-fixtures-v1',
    fixtureSetId: incident.id,
  };
  incident.timeline = [
    {
      id: 'request',
      offsetMs: 0,
      type: 'http.request',
      method: 'POST',
      route: profile === 'auth-case-normalization-v1' ? '/auth/login' : '/orders',
    },
    { id: 'error', offsetMs: 1, type: 'error', code: incident.failure.code },
    { id: 'response', offsetMs: 1, type: 'http.response', statusCode: baselineStatus },
  ];
  const replayFixture: ReplayFixture = {
    schemaVersion: 1,
    runner: 'express-orders-v1',
    artifactId: image,
    profile,
    ...(profile === 'orders-create-v1' ? { quantity: 2 } : {}),
  };
  const ingest = await collector.app.inject({
    method: 'POST',
    url: '/v1/incidents',
    headers,
    payload: { captureVersion: 1, incident, replayFixture },
  });
  expect(ingest.statusCode).toBe(201);
  return { ...collector, store, incident, replayFixture };
}
test('replay endpoints authenticate and preserve run history', async () => {
  const { app, incident } = await setup();
  const url = `/v1/incidents/${incident.id}/replays`;
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect((await app.inject({ url, headers })).json().available).toBe(true);
  const response = await app.inject({
    method: 'POST',
    url,
    headers,
    payload: { mode: 'captured' },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().run).toMatchObject({
    status: 'reproduced',
    expected: { statusCode: 500, errorCode: 'ORDER_CREATION_FAILED' },
  });
  expect((await app.inject({ url, headers })).json().runs).toHaveLength(1);
});
test('runner failures are recorded without exposing raw errors', async () => {
  const { app, incident } = await setup({
    run: async () => {
      throw new ReplayExecutionError('RUN_TIMEOUT');
    },
    close: async () => {},
  });
  const response = await app.inject({
    method: 'POST',
    url: `/v1/incidents/${incident.id}/replays`,
    headers,
    payload: {},
  });
  expect(response.json().run).toMatchObject({
    status: 'failed',
    errorCode: 'RUN_TIMEOUT',
  });
});
test('old candidates without fixtures remain unavailable and fixtures are immutable', async () => {
  const { app, store, replayFixture, incident } = await setup();
  const old = fixture();
  await store.save(old);
  expect(
    (await app.inject({ url: `/v1/incidents/${old.id}/replays`, headers })).json().reason,
  ).toBe('missing-fixture');
  const conflict = await app.inject({
    method: 'POST',
    url: '/v1/incidents',
    headers,
    payload: {
      captureVersion: 1,
      incident,
      replayFixture: { ...replayFixture, quantity: 3 },
    },
  });
  expect(conflict.statusCode).toBe(409);
});

test('verifies a changed current-build response against an explicit target and persists it', async () => {
  const { app, incident, store } = await setup({
    run: async () => ({
      statusCode: 503,
      errorCode: 'ORDER_CREATION_FAILED',
      retryAfterSeconds: 5,
      responseHint: 'temporary-unavailable',
      runtimeVersion: '24.3.0',
      timeline: [{ id: 'response', type: 'http.response', statusCode: 503, offsetMs: 1 }],
    }),
    close: async () => {},
  });
  const url = `/v1/incidents/${incident.id}/replays`;
  const target = {
    statusCode: 503,
    errorCode: 'ORDER_CREATION_FAILED',
    retryAfterSeconds: 5,
  };
  const response = await app.inject({
    method: 'POST',
    url,
    headers,
    payload: { mode: 'current', target },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().run).toMatchObject({
    status: 'not-reproduced',
    verification: 'matched',
    target,
    expected: { statusCode: 500 },
    actual: { statusCode: 503, retryAfterSeconds: 5 },
  });
  expect((await store.listReplayRuns(incident.id))[0]!.verification).toBe('matched');
  expect((await store.get(incident.id))!.timeline.at(-1)).toMatchObject({
    statusCode: 500,
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { mode: 'captured', target },
      })
    ).statusCode,
  ).toBe(400);
});
test('a changed status alone does not pass a target with mismatched retry guidance', async () => {
  const { app, incident } = await setup({
    run: async () => ({
      statusCode: 503,
      errorCode: 'ORDER_CREATION_FAILED',
      runtimeVersion: '24.3.0',
      timeline: [{ id: 'response', type: 'http.response', statusCode: 503, offsetMs: 1 }],
    }),
    close: async () => {},
  });
  const response = await app.inject({
    method: 'POST',
    url: `/v1/incidents/${incident.id}/replays`,
    headers,
    payload: {
      mode: 'current',
      target: {
        statusCode: 503,
        errorCode: 'ORDER_CREATION_FAILED',
        retryAfterSeconds: 5,
      },
    },
  });
  expect(response.json().run).toMatchObject({
    status: 'not-reproduced',
    verification: 'not-matched',
  });
});

test('new 503 outage captures remain replayable and compare against their own baseline', async () => {
  const { app, incident } = await setup(
    {
      run: async () => ({
        statusCode: 503,
        errorCode: 'ORDER_CREATION_FAILED',
        runtimeVersion: '24.3.0',
        retryAfterSeconds: 5,
        timeline: [
          { id: 'response', type: 'http.response', statusCode: 503, offsetMs: 1 },
        ],
      }),
      close: async () => {},
    },
    503,
  );
  const url = `/v1/incidents/${incident.id}/replays`;
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        payload: {
          mode: 'current',
          target: { statusCode: 503, errorCode: 'ORDER_CREATION_FAILED' },
        },
      })
    ).statusCode,
  ).toBe(401);
  const result = await app.inject({
    method: 'POST',
    url,
    headers,
    payload: { mode: 'captured' },
  });
  expect(result.statusCode).toBe(201);
  expect(result.json().run).toMatchObject({
    status: 'reproduced',
    expected: { statusCode: 503 },
  });
});

test('auth verification confirms actual session proof and rejects a status-only target', async () => {
  const executor: ReplayExecutor = {
    run: async () => ({
      statusCode: 200,
      errorCode: null,
      outcome: 'authenticated-test-user',
      runtimeVersion: '24.3.0',
      timeline: [{ id: 'response', type: 'http.response', statusCode: 200, offsetMs: 2 }],
    }),
    close: async () => {},
  };
  const { app, incident, store } = await setup(
    executor,
    500,
    'auth-case-normalization-v1',
  );
  const url = `/v1/incidents/${incident.id}/replays`;
  const target = { statusCode: 200, errorCode: null, outcome: 'authenticated-test-user' };
  const response = await app.inject({
    method: 'POST',
    url,
    headers,
    payload: { mode: 'current', target },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().run).toMatchObject({
    status: 'not-reproduced',
    verification: 'matched',
    expected: { statusCode: 500, errorCode: 'AUTH_LOGIN_FAILED' },
    actual: { statusCode: 200, outcome: 'authenticated-test-user' },
  });
  expect((await store.listReplayRuns(incident.id))[0]!.target).toEqual(target);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { mode: 'current', target: { statusCode: 200, errorCode: null } },
      })
    ).statusCode,
  ).toBe(400);
  expect(JSON.stringify(response.json())).not.toContain('sessionToken');
});
test('HTTP 200 without authenticated session evidence does not verify the auth fix', async () => {
  const { app, incident } = await setup(
    {
      run: async () => ({
        statusCode: 200,
        errorCode: null,
        runtimeVersion: '24.3.0',
        timeline: [
          { id: 'response', type: 'http.response', statusCode: 200, offsetMs: 2 },
        ],
      }),
      close: async () => {},
    },
    500,
    'auth-case-normalization-v1',
  );
  const response = await app.inject({
    method: 'POST',
    url: `/v1/incidents/${incident.id}/replays`,
    headers,
    payload: {
      mode: 'current',
      target: { statusCode: 200, errorCode: null, outcome: 'authenticated-test-user' },
    },
  });
  expect(response.json().run.verification).toBe('not-matched');
});
