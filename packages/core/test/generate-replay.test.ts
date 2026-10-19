import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  parseIncidentJson,
  generateRecordedReplay,
  type ReplayAppRegistry,
} from '../src/index.js';
const image = `sha256:${'a'.repeat(64)}`;
function setup() {
  const incident = parseIncidentJson(
    readFileSync(new URL('./fixtures/node-http-candidate.json', import.meta.url), 'utf8'),
  );
  incident.service.name = 'checkout-api';
  incident.failure.code = 'HTTP_500';
  incident.timeline = [
    {
      id: 'request',
      type: 'http.request',
      method: 'POST',
      route: '/checkout',
      offsetMs: 0,
    },
    { id: 'error', type: 'error', code: 'HTTP_500', offsetMs: 1 },
    { id: 'response', type: 'http.response', statusCode: 500, offsetMs: 1 },
  ];
  incident.adapter.capabilities.replay = [];
  incident.replay = { status: 'unsupported', reason: 'missing-fixtures' };
  incident.recording = {
    version: 1,
    policyId: 'safe-v1',
    artifactId: image,
    request: {
      method: 'POST',
      route: '/checkout',
      body: { quantity: 2 },
      partial: false,
    },
    dependencies: [
      {
        id: 'pricing',
        origin: 'http://127.0.0.1:4330',
        method: 'GET',
        route: '/price',
        statusCode: 200,
        body: { unitCents: 1500 },
        partial: false,
        result: 'response',
      },
    ],
    truncated: false,
  };
  const registry: ReplayAppRegistry = {
    apps: [
      {
        service: 'checkout-api',
        currentArtifactId: image,
        artifacts: [image],
        fixtures: [
          {
            schemaVersion: 1,
            runner: 'express-app-v1',
            inputMode: 'recorded-http',
            artifactId: image,
            service: 'checkout-api',
            profile: 'checkout',
            scenarioVersion: 'v1',
            method: 'POST',
            route: '/checkout',
            failureCode: 'HTTP_500',
            contractHash: 'a'.repeat(64),
            target: {
              statusCode: 200,
              errorCode: null,
              outcome: 'scenario-assertions-passed',
            },
          },
        ],
      },
    ],
  };
  return { incident, registry };
}
it('generates a candidate from recorded inputs without changing the original object', () => {
  const { incident, registry } = setup();
  const generated = generateRecordedReplay(incident, registry);
  expect(generated.reason).toBeNull();
  expect(generated.fixture).toMatchObject({
    recording: incident.recording,
    artifactId: image,
  });
  expect(generated.incident.replay.status).toBe('candidate');
  expect(incident.replay.status).toBe('unsupported');
});
it('blocks partial data, missing builds, ambiguous contracts and unsupported routes', () => {
  for (const mutate of [
    ({ incident }: ReturnType<typeof setup>) => {
      incident.recording!.request.partial = true;
    },
    ({ incident }: ReturnType<typeof setup>) => {
      delete incident.recording!.artifactId;
    },
    ({ incident }: ReturnType<typeof setup>) => {
      incident.recording!.dependencies[0]!.result = 'transport-error';
    },
    ({ incident }: ReturnType<typeof setup>) => {
      incident.recording!.request.route = '/checkout/:id';
    },
    ({ registry }: ReturnType<typeof setup>) => {
      registry.apps[0]!.fixtures.push({
        ...registry.apps[0]!.fixtures[0]!,
        profile: 'another',
      });
    },
  ]) {
    const state = setup();
    mutate(state);
    expect(
      generateRecordedReplay(state.incident, state.registry).fixture,
    ).toBeUndefined();
  }
});

it('accepts complete PostgreSQL snapshots but blocks partial queries', () => {
  const state = setup();
  state.incident.recording!.postgres = [
    {
      id: 'zone-rate',
      queryHash: 'a'.repeat(64),
      parameters: ['LOCAL'],
      rows: [{ rate_per_km: 2 }],
      rowCount: 1,
      result: 'rows',
      partial: false,
    },
  ];
  expect(generateRecordedReplay(state.incident, state.registry).fixture).toBeDefined();
  state.incident.recording!.postgres[0]!.partial = true;
  expect(generateRecordedReplay(state.incident, state.registry).reason).toBe(
    'recording-incomplete',
  );
});

it('requires explicit synthetic database mode on both capture and reviewed contract', () => {
  const { incident, registry } = setup();
  incident.recording!.databaseMode = 'synthetic-postgres';
  const contract = registry.apps[0]!.fixtures[0]!;
  expect(generateRecordedReplay(incident, registry).reason).toBe('missing-fixture');
  contract.inputMode = 'synthetic-postgres';
  contract.databaseFixtureHash = 'c'.repeat(64);
  expect(generateRecordedReplay(incident, registry).fixture).toMatchObject({
    inputMode: 'synthetic-postgres',
    databaseFixtureHash: 'c'.repeat(64),
  });
  incident.recording!.request.partial = true;
  expect(generateRecordedReplay(incident, registry).reason).toBe('recording-incomplete');
});
