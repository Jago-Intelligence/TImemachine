import { expect, it } from 'vitest';
import { fixture, headers, testCollector } from './helpers.js';

it('persists selected recordings with authenticated incident lookup', async () => {
  const { app } = await testCollector();
  try {
    const incident = fixture();
    const request = incident.timeline.find((event) => event.type === 'http.request')!;
    if (request.type !== 'http.request') throw new Error('Missing request');
    const recording = {
      version: 1,
      policyId: 'safe-v1',
      request: {
        method: request.method,
        route: request.route,
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
    };
    const payload = { ...incident, recording };
    expect(
      (await app.inject({ method: 'POST', url: '/v1/incidents', headers, payload }))
        .statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/incidents', headers, payload }))
        .statusCode,
    ).toBe(200);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/incidents/${incident.id}`,
      headers,
    });
    expect(detail.json().incident.recording).toEqual(recording);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/incidents/${incident.id}` }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers,
          payload: {
            ...payload,
            recording: {
              ...recording,
              request: { ...recording.request, body: { password: 'secret' } },
            },
          },
        })
      ).statusCode,
    ).toBe(422);
  } finally {
    await app.close();
  }
});

it('retains structured cause evidence without accepting an unrelated source location', async () => {
  const { app } = await testCollector();
  try {
    const incident = fixture();
    incident.failure.frames = [{ file: 'src/app.js', line: 8, column: 43 }];
    incident.failure.name = 'TypeError';
    incident.failure.sourceAccess = {
      file: 'src/app.js',
      line: 8,
      column: 43,
      sourceHash: 'a'.repeat(64),
      field: 'rate',
      operation: 'toFixed',
      dependencyId: 'pricing',
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers,
          payload: incident,
        })
      ).statusCode,
    ).toBe(201);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/incidents/${incident.id}`,
      headers,
    });
    expect(detail.json().incident.failure.sourceAccess).toEqual(
      incident.failure.sourceAccess,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers,
          payload: {
            ...incident,
            failure: {
              ...incident.failure,
              sourceAccess: { ...incident.failure.sourceAccess, line: 999 },
            },
          },
        })
      ).statusCode,
    ).toBe(422);
  } finally {
    await app.close();
  }
});

it('persists selected PostgreSQL results under normal incident authentication and rejects unsafe row fields', async () => {
  const { app } = await testCollector();
  try {
    const incident = fixture();
    const request = incident.timeline.find((event) => event.type === 'http.request')!;
    if (request.type !== 'http.request') throw new Error('Missing request');
    incident.recording = {
      version: 1,
      policyId: 'db-v1',
      request: {
        method: request.method,
        route: request.route,
        body: { zoneCode: 'LOCAL' },
        partial: false,
      },
      dependencies: [],
      postgres: [
        {
          id: 'zone-rate',
          queryHash: 'a'.repeat(64),
          parameters: ['LOCAL'],
          rows: [{ rate_per_km: 2 }],
          rowCount: 1,
          result: 'rows',
          partial: false,
        },
      ],
      truncated: false,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers,
          payload: incident,
        })
      ).statusCode,
    ).toBe(201);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/incidents/${incident.id}`,
      headers,
    });
    expect(detail.json().incident.recording.postgres).toEqual(
      incident.recording.postgres,
    );
    incident.recording.postgres![0]!.rows = [{ password: 'private' }];
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers,
          payload: incident,
        })
      ).statusCode,
    ).toBe(422);
  } finally {
    await app.close();
  }
});
