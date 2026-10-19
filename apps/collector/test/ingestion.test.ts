import { afterEach, describe, expect, it } from 'vitest';
import { INCIDENT_LIMITS } from '@timemachine/core';
import { createMemoryStore } from '@timemachine/storage';
import { fixture, headers, testCollector, token } from './helpers.js';

const running: Awaited<ReturnType<typeof testCollector>>[] = [];
async function setup(
  env: Record<string, string> = {},
  store?: ReturnType<typeof createMemoryStore>,
) {
  const collector = await testCollector(env, store);
  running.push(collector);
  return collector;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map(({ shutdown }) => shutdown()));
});

describe('authenticated incident ingestion', () => {
  it('accepts, sanitizes and retrieves an incident', async () => {
    const { app, store } = await setup();
    const incident = fixture();
    incident.failure.summary = 'password=private-fixture-secret';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload: incident,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      apiVersion: 1,
      incidentId: incident.id,
      status: 'accepted',
    });
    expect(response.headers.location).toBe(`/v1/incidents/${incident.id}`);
    const fetched = await app.inject({
      url: response.headers.location as string,
      headers,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().incident.failure).toMatchObject({
      name: 'CapturedError',
      summary: 'Failure details omitted by collector sanitization policy.',
    });
    expect(fetched.body).not.toContain('private-fixture-secret');
    expect(fetched.json().incident.failure.frames[0]).not.toHaveProperty('function');
    expect(await store.get(incident.id)).toEqual(fetched.json().incident);
  });

  it('uses canonical UUIDs for ingestion and lookup', async () => {
    const { app } = await setup();
    const incident = fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload: { ...incident, id: incident.id.toUpperCase() },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().incidentId).toBe(incident.id);
    expect(
      (await app.inject({ url: `/v1/incidents/${incident.id.toUpperCase()}`, headers }))
        .statusCode,
    ).toBe(200);
  });

  it.each([undefined, 'Bearer incorrect', 'Basic incorrect', `Bearer ${token}extra`])(
    'rejects unauthorized ingestion and lookup: %s',
    async (authorization) => {
      const { app, store } = await setup();
      const requestHeaders = {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      };
      for (const request of [
        { method: 'POST' as const, url: '/v1/incidents', payload: '{not valid JSON' },
        { method: 'GET' as const, url: `/v1/incidents/${fixture().id}` },
      ]) {
        const response = await app.inject({ ...request, headers: requestHeaders });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('UNAUTHORIZED');
        expect(response.headers['www-authenticate']).toContain('Bearer');
      }
      expect(await store.get(fixture().id)).toBeUndefined();
    },
  );

  it('makes matching retries idempotent and rejects different data at the same ID', async () => {
    const { app } = await setup();
    const incident = fixture();
    const request = {
      method: 'POST' as const,
      url: '/v1/incidents',
      headers,
      payload: incident,
    };
    expect((await app.inject(request)).statusCode).toBe(201);
    const duplicate = await app.inject(request);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().status).toBe('duplicate');
    incident.service.version = '0.2.0';
    const conflict = await app.inject({ ...request, payload: incident });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('INCIDENT_CONFLICT');
  });

  it('rejects invalid UTF-8 bytes before schema validation', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload: Buffer.from([0x22, 0xc3, 0x28, 0x22]),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_JSON');
  });

  it.each([
    ['{', 400, 'INVALID_JSON'],
    ['', 400, 'INVALID_JSON'],
    [JSON.stringify({ schemaVersion: 2 }), 422, 'UNSUPPORTED_SCHEMA_VERSION'],
    [JSON.stringify({ schemaVersion: 1 }), 422, 'INVALID_INCIDENT'],
  ])('maps invalid input to a stable envelope: %s', async (payload, status, code) => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({
      apiVersion: 1,
      error: {
        code,
        requestId: response.headers['x-request-id'],
        correlationId: response.headers['x-correlation-id'],
      },
    });
  });

  it.each([
    'text/plain',
    'application/json; charset=latin1',
    'application/json; charset="utf-8',
    'application/octet-stream',
  ])('rejects unsupported content type %s', async (type) => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: { ...headers, 'content-type': type },
      payload: JSON.stringify(fixture()),
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('accepts UTF-8 media parameters and rejects encoded bodies', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: { ...headers, 'content-type': 'application/json; charset="UTF-8"' },
      payload: JSON.stringify(fixture()),
    });
    expect(response.statusCode).toBe(201);
    const compressed = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers: { ...headers, 'content-encoding': 'gzip' },
      payload: 'compressed-data',
    });
    expect(compressed.statusCode).toBe(415);
  });

  it('rejects oversized wire input before persistence', async () => {
    const { app, store } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload: ' '.repeat(INCIDENT_LIMITS.bytes + 1),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('INCIDENT_TOO_LARGE');
    expect(await store.get(fixture().id)).toBeUndefined();
  });

  it('rejects unexpected payload fields and collector credentials without disclosure', async () => {
    const { app, logs, store } = await setup();
    const incident = fixture();
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload: { ...incident, 'private-secret-field': 'private-secret-value' },
    });
    expect(unknown.statusCode).toBe(422);
    incident.failure.summary = token;
    const credential = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload: incident,
    });
    expect(credential.statusCode).toBe(422);
    expect(credential.json().error.code).toBe('SENSITIVE_INCIDENT_METADATA');
    for (const secret of [token, 'private-secret-field', 'private-secret-value']) {
      expect(unknown.body + credential.body + logs.join('')).not.toContain(secret);
    }
    expect(await store.get(incident.id)).toBeUndefined();
  });

  it('reports capacity exhaustion without evicting accepted incidents', async () => {
    const store = createMemoryStore({
      maxEntries: 1,
      maxBytes: 1024 * 1024,
      retentionMs: 60000,
    });
    const { app } = await setup({}, store);
    const original = fixture();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers,
          payload: original,
        })
      ).statusCode,
    ).toBe(201);
    const next = { ...original, id: '284977b1-c89a-4d1b-8b74-247c59d08743' };
    const full = await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload: next,
    });
    expect(full.statusCode).toBe(503);
    expect(full.json().error.code).toBe('STORE_CAPACITY_EXCEEDED');
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(503);
    expect(
      (await app.inject({ url: `/v1/incidents/${original.id}`, headers })).statusCode,
    ).toBe(200);
  });

  it('distinguishes malformed identifiers from absent incidents', async () => {
    const { app } = await setup();
    const malformed = await app.inject({ url: '/v1/incidents/not-a-uuid', headers });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('INVALID_INCIDENT_ID');
    const absent = await app.inject({ url: `/v1/incidents/${fixture().id}`, headers });
    expect(absent.statusCode).toBe(404);
    expect(absent.json().error.code).toBe('INCIDENT_NOT_FOUND');
  });
});
