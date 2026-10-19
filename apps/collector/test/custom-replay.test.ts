import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { parseServerConfig } from '@timemachine/config';
import { createMemoryStore } from '@timemachine/storage';
import { createCollector } from '../src/server.js';
import { createReplayService } from '../src/replay-service.js';
import { fixture, headers, token } from './helpers.js';
import type { ReplayExecutor } from '@timemachine/replay';
import type { ReplayFixture, ReplayAppRegistry } from '@timemachine/core';
const before = `sha256:${'a'.repeat(64)}`,
  current = `sha256:${'b'.repeat(64)}`,
  unrelated = `sha256:${'c'.repeat(64)}`;
function custom(): Extract<ReplayFixture, { runner: 'express-app-v1' }> {
  return {
    schemaVersion: 1,
    runner: 'express-app-v1',
    artifactId: before,
    service: 'my-api',
    profile: 'profile-update',
    scenarioVersion: 'v1',
    method: 'PATCH',
    route: '/profiles/:id',
    failureCode: 'PROFILE_UPDATE_FAILED',
    contractHash: 'a'.repeat(64),
    target: { statusCode: 200, errorCode: null, outcome: 'scenario-assertions-passed' },
  };
}
function capture(replayFixture: ReturnType<typeof custom>) {
  const incident = fixture();
  incident.id = randomUUID();
  incident.service.name = replayFixture.service;
  incident.service.version = '2.0.0';
  incident.failure.code = replayFixture.failureCode;
  incident.replay = {
    status: 'candidate',
    mode: 'node-http-fixtures-v1',
    fixtureSetId: incident.id,
  };
  incident.timeline = [
    {
      id: 'request',
      type: 'http.request',
      method: replayFixture.method,
      route: replayFixture.route,
      offsetMs: 0,
    },
    { id: 'error', type: 'error', code: replayFixture.failureCode, offsetMs: 1 },
    { id: 'response', type: 'http.response', statusCode: 500, offsetMs: 1 },
  ];
  return incident;
}
it('uses the owning app current build and prevents cross-app image reuse', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-custom-replay-'));
  const registryPath = join(directory, 'registry.json');
  const replayFixture = custom();
  const registry: ReplayAppRegistry = {
    apps: [
      {
        service: 'my-api',
        currentArtifactId: current,
        artifacts: [before, current],
        fixtures: [{ ...replayFixture, artifactId: current }],
      },
    ],
  };
  writeFileSync(registryPath, JSON.stringify(registry));
  const run = vi.fn<ReplayExecutor['run']>(async () => ({
    statusCode: 200,
    errorCode: null,
    outcome: 'scenario-assertions-passed' as const,
    runtimeVersion: '24.0.0',
    timeline: [
      { id: 'response', type: 'http.response' as const, statusCode: 200, offsetMs: 1 },
    ],
  }));
  const collector = await createCollector({
    config: parseServerConfig({
      NODE_ENV: 'test',
      TIMEMACHINE_AUTH_TOKEN: token,
      LOG_LEVEL: 'silent',
      REPLAY_APPS_FILE: registryPath,
      REPLAY_IMAGE_ID: unrelated,
    }),
    store: createMemoryStore({ maxEntries: 10, maxBytes: 1048576, retentionMs: 60000 }),
    replayExecutor: { run, close: async () => {} },
  });
  try {
    const incident = capture(replayFixture);
    expect(
      (
        await collector.app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers,
          payload: { captureVersion: 1, incident, replayFixture },
        })
      ).statusCode,
    ).toBe(201);
    const result = await collector.app.inject({
      method: 'POST',
      url: `/v1/incidents/${incident.id}/replays`,
      headers,
      payload: { mode: 'current', target: replayFixture.target },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json().run).toMatchObject({
      verification: 'matched',
      artifactId: current,
      actual: { statusCode: 200 },
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      artifactId: current,
      profile: replayFixture.profile,
    });
    const other = { ...replayFixture, artifactId: unrelated };
    const otherIncident = capture(other);
    await collector.app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload: { captureVersion: 1, incident: otherIncident, replayFixture: other },
    });
    const denied = await collector.app.inject({
      method: 'POST',
      url: `/v1/incidents/${otherIncident.id}/replays`,
      headers,
      payload: { mode: 'captured' },
    });
    expect(denied.statusCode).toBe(409);
    expect(
      (await collector.app.inject(`/v1/incidents/${incident.id}/replays`)).statusCode,
    ).toBe(401);
  } finally {
    await collector.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it('rejects current-build verification when the original scenario or target changed', async () => {
  const store = createMemoryStore({
    maxEntries: 10,
    maxBytes: 1048576,
    retentionMs: 60000,
  });
  const replayFixture = custom();
  const incident = capture(replayFixture);
  await store.save(incident, replayFixture);
  const run = vi.fn();
  const executor = { run, close: async () => {} };
  const registry: ReplayAppRegistry = {
    apps: [
      {
        service: 'my-api',
        currentArtifactId: current,
        artifacts: [before, current],
        fixtures: [
          { ...replayFixture, artifactId: current, contractHash: 'b'.repeat(64) },
        ],
      },
    ],
  };
  const changed = createReplayService(
    store,
    executor,
    [before, current],
    undefined,
    registry,
  );
  await expect(
    changed.run(incident.id, 'current', replayFixture.target),
  ).rejects.toMatchObject({ code: 'REPLAY_SCENARIO_CHANGED' });
  registry.apps[0]!.fixtures[0]!.contractHash = replayFixture.contractHash;
  const same = createReplayService(
    store,
    executor,
    [before, current],
    undefined,
    registry,
  );
  await expect(
    same.run(incident.id, 'current', { statusCode: 200, errorCode: null }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(run).not.toHaveBeenCalled();
  await store.close();
});

it('generates a saved replay automatically on recording ingestion and reuses inputs for current builds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-generated-replay-'));
  const registryPath = join(directory, 'registry.json');
  const replayFixture = {
    ...custom(),
    inputMode: 'recorded-http' as const,
    method: 'POST' as const,
    route: '/checkout',
    failureCode: 'HTTP_500',
  };
  const registry: ReplayAppRegistry = {
    apps: [
      {
        service: 'my-api',
        currentArtifactId: before,
        artifacts: [before],
        fixtures: [replayFixture],
      },
    ],
  };
  writeFileSync(registryPath, JSON.stringify(registry));
  let status = 500;
  const run = vi.fn<ReplayExecutor['run']>(async () => ({
    statusCode: status,
    errorCode: status === 500 ? 'HTTP_500' : null,
    ...(status === 200 ? { outcome: 'scenario-assertions-passed' as const } : {}),
    runtimeVersion: '24.0.0',
    timeline: [
      { id: 'response', type: 'http.response' as const, statusCode: status, offsetMs: 1 },
    ],
  }));
  const store = createMemoryStore({
    maxEntries: 10,
    maxBytes: 1048576,
    retentionMs: 60000,
  });
  const collector = await createCollector({
    config: parseServerConfig({
      NODE_ENV: 'test',
      TIMEMACHINE_AUTH_TOKEN: token,
      LOG_LEVEL: 'silent',
      REPLAY_APPS_FILE: registryPath,
    }),
    store,
    replayExecutor: { run, close: async () => {} },
  });
  try {
    const incident = capture(replayFixture);
    incident.adapter.capabilities.replay = [];
    incident.replay = { status: 'unsupported', reason: 'missing-fixtures' };
    incident.recording = {
      version: 1,
      policyId: 'safe-v1',
      artifactId: before,
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
    for (const expected of [201, 200])
      expect(
        (
          await collector.app.inject({
            method: 'POST',
            url: '/v1/incidents',
            headers,
            payload: incident,
          })
        ).statusCode,
      ).toBe(expected);
    expect((await store.get(incident.id))?.replay.status).toBe('candidate');
    expect((await store.getReplayFixture(incident.id))?.runner).toBe('express-app-v1');
    const captured = await collector.app.inject({
      method: 'POST',
      url: `/v1/incidents/${incident.id}/replays`,
      headers,
      payload: { mode: 'captured' },
    });
    expect(captured.json().run.status).toBe('reproduced');
    const updatedRegistry: ReplayAppRegistry = {
      apps: [
        {
          ...registry.apps[0]!,
          currentArtifactId: current,
          artifacts: [before, current],
          fixtures: [{ ...replayFixture, artifactId: current }],
        },
      ],
    };
    status = 200;
    const service = createReplayService(
      store,
      { run, close: async () => {} },
      [before, current],
      undefined,
      updatedRegistry,
    );
    const verified = await service.run(incident.id, 'current', replayFixture.target);
    expect(verified.run).toMatchObject({
      status: 'not-reproduced',
      verification: 'matched',
      actual: { statusCode: 200 },
    });
    expect(run.mock.calls[1]![0]).toMatchObject({
      artifactId: current,
      recording: incident.recording,
    });
    expect(
      (await store.get(incident.id))?.timeline.findLast(
        (event) => event.type === 'http.response',
      ),
    ).toMatchObject({ statusCode: 500 });
  } finally {
    await collector.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
