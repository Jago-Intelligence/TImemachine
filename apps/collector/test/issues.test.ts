import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, headers, testCollector } from './helpers.js';
it('authenticates grouped issues and preserves occurrence lookups', async () => {
  const { app } = await testCollector();
  try {
    const first = fixture();
    const second = { ...fixture(), id: randomUUID() };
    for (const incident of [first, second, first])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/incidents',
            headers,
            payload: incident,
          })
        ).statusCode,
      ).toBeLessThan(300);
    expect((await app.inject('/v1/issues')).statusCode).toBe(401);
    const groups = await app.inject({ method: 'GET', url: '/v1/issues', headers });
    expect(groups.statusCode).toBe(200);
    const body = groups.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].occurrences).toBe(2);
    const id = body.items[0].id;
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/issues/${id}?limit=1`,
      headers,
    });
    expect(detail.json().occurrences.items).toHaveLength(1);
    expect(detail.json().occurrences.nextCursor).toBeTruthy();
    const incident = await app.inject({
      method: 'GET',
      url: `/v1/incidents/${first.id}`,
      headers,
    });
    expect(incident.json().incident.id).toBe(first.id);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/issues?limit=101', headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/issues/invalid', headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/issues/${'0'.repeat(64)}`, headers }))
        .statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});

it('protects issue resolution with bearer authentication and rejects unverified requests', async () => {
  const { app } = await testCollector();
  try {
    const incident = fixture();
    await app.inject({
      method: 'POST',
      url: '/v1/incidents',
      headers,
      payload: incident,
    });
    const id = (await app.inject({ method: 'GET', url: '/v1/issues', headers })).json()
      .items[0].id;
    const payload = { incidentId: incident.id, runId: randomUUID(), revision: 1 };
    expect(
      (await app.inject({ method: 'POST', url: `/v1/issues/${id}/resolve`, payload }))
        .statusCode,
    ).toBe(401);
    const unverified = await app.inject({
      method: 'POST',
      url: `/v1/issues/${id}/resolve`,
      headers,
      payload,
    });
    expect(unverified.statusCode).toBe(409);
    expect(unverified.json().error.code).toBe('VERIFICATION_REQUIRED');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/issues/${id}/resolve`,
          headers,
          payload: { ...payload, status: 'resolved' },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
