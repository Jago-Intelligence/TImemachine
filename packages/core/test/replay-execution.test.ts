import { expect, test } from 'vitest';
import { replayFixtureSchema, fixtureContract } from '../src/replay-execution.js';
const base = {
  schemaVersion: 1,
  runner: 'express-orders-v1',
  artifactId: `sha256:${'a'.repeat(64)}`,
};
test('only reviewed numeric fixture data is accepted', () => {
  expect(
    replayFixtureSchema.parse({ ...base, profile: 'orders-create-v1', quantity: 2 })
      .quantity,
  ).toBe(2);
  for (const input of [
    { ...base, profile: 'orders-create-v1' },
    { ...base, profile: 'orders-create-v1', quantity: 0 },
    { ...base, profile: 'orders-read-v1', quantity: 2 },
    { ...base, profile: 'orders-read-v1', token: 'private' },
    { ...base, profile: 'orders-create-v1', quantity: 2, command: 'arbitrary code' },
  ])
    expect(replayFixtureSchema.safeParse(input).success).toBe(false);
});
test('profiles define fixed routes and error contracts', () => {
  expect(
    fixtureContract(
      replayFixtureSchema.parse({ ...base, profile: 'orders-update-v1', quantity: 3 }),
    ),
  ).toEqual({ method: 'PATCH', route: '/orders/:id', code: 'ORDER_UPDATE_FAILED' });
});

test('verification validates a current-build target and compares only requested fields', async () => {
  const { replayRequestSchema, matchesReplayExpectation } =
    await import('../src/replay-execution.js');
  const target = {
    statusCode: 503,
    errorCode: 'ORDER_CREATION_FAILED',
    retryAfterSeconds: 5,
  };
  expect(replayRequestSchema.safeParse({ mode: 'captured', target }).success).toBe(false);
  expect(
    replayRequestSchema.safeParse({
      mode: 'current',
      target: { ...target, command: 'execute' },
    }).success,
  ).toBe(false);
  expect(
    replayRequestSchema.safeParse({
      mode: 'current',
      target: { ...target, statusCode: 999 },
    }).success,
  ).toBe(false);
  const actual = {
    statusCode: 503,
    errorCode: 'ORDER_CREATION_FAILED',
    retryAfterSeconds: 5,
    runtimeVersion: '24.0.0',
    timeline: [
      { id: 'response', type: 'http.response' as const, statusCode: 503, offsetMs: 1 },
    ],
  };
  expect(matchesReplayExpectation(actual, target)).toBe(true);
  expect(matchesReplayExpectation({ ...actual, retryAfterSeconds: 10 }, target)).toBe(
    false,
  );
  expect(matchesReplayExpectation({ ...actual, errorCode: null }, target)).toBe(false);
  expect(
    matchesReplayExpectation(actual, {
      statusCode: 503,
      errorCode: 'ORDER_CREATION_FAILED',
    }),
  ).toBe(true);
});

test('authentication success requires verified identity/session evidence beyond HTTP 200', async () => {
  const { replayFixtureSchema, matchesReplayExpectation } =
    await import('../src/replay-execution.js');
  expect(
    replayFixtureSchema.safeParse({
      ...base,
      profile: 'auth-case-normalization-v1',
      password: 'private',
    }).success,
  ).toBe(false);
  const actual = {
    statusCode: 200,
    errorCode: null,
    runtimeVersion: '24.0.0',
    timeline: [
      { id: 'response', type: 'http.response' as const, statusCode: 200, offsetMs: 2 },
    ],
  };
  const target = {
    statusCode: 200,
    errorCode: null,
    outcome: 'authenticated-test-user' as const,
  };
  expect(matchesReplayExpectation(actual, target)).toBe(false);
  expect(
    matchesReplayExpectation({ ...actual, outcome: 'authenticated-test-user' }, target),
  ).toBe(true);
});

test('custom Express contracts reject arbitrary payloads and do not require demo service names', async () => {
  const { replayFixtureSchema, validateReplayBinding } =
    await import('../src/replay-execution.js');
  const { readFileSync } = await import('node:fs');
  const incident = JSON.parse(
    readFileSync(new URL('./fixtures/node-http-candidate.json', import.meta.url), 'utf8'),
  );
  incident.service.name = 'my-api';
  incident.service.version = '2.0.0';
  incident.failure.code = 'PROFILE_FAILED';
  incident.replay.fixtureSetId = incident.id;
  incident.timeline = [
    {
      id: 'request',
      type: 'http.request',
      method: 'PATCH',
      route: '/profiles/:id',
      offsetMs: 0,
    },
    { id: 'response', type: 'http.response', statusCode: 502, offsetMs: 1 },
  ];
  const input = {
    schemaVersion: 1,
    runner: 'express-app-v1',
    artifactId: `sha256:${'a'.repeat(64)}`,
    service: 'my-api',
    profile: 'rename-v1',
    scenarioVersion: 'v1',
    method: 'PATCH',
    route: '/profiles/:id',
    failureCode: 'PROFILE_FAILED',
    contractHash: 'a'.repeat(64),
    target: { statusCode: 200, errorCode: null, outcome: 'scenario-assertions-passed' },
  };
  expect(validateReplayBinding(incident, input).runner).toBe('express-app-v1');
  expect(
    replayFixtureSchema.safeParse({ ...input, body: { password: 'private' } }).success,
  ).toBe(false);
  expect(() =>
    validateReplayBinding(incident, { ...input, service: 'another-app' }),
  ).toThrow();
});
