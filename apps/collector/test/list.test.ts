import type { IncidentPage } from '@timemachine/storage';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { fixture, headers, testCollector } from './helpers.js';
const running: Awaited<ReturnType<typeof testCollector>>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(({ shutdown }) => shutdown()));
});
async function setup() {
  const collector = await testCollector();
  running.push(collector);
  return collector;
}
test('requires authentication before validating list queries', async () => {
  const { app } = await setup();
  expect((await app.inject('/v1/incidents?limit=invalid')).statusCode).toBe(401);
});
test.each([
  'limit=0',
  'limit=101',
  'limit=1.5',
  'limit=01',
  'limit=2&limit=3',
  'cursor=invalid',
  'service=bad%20name',
  'unknown=1',
])('rejects invalid list query %s', async (query) => {
  const { app } = await setup();
  const response = await app.inject({ url: `/v1/incidents?${query}`, headers });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe('INVALID_LIST_QUERY');
});
test('returns bounded summaries and paginates tied timestamps without overlap', async () => {
  const { app } = await setup();
  const ids = Array.from({ length: 5 }, () => randomUUID())
    .sort()
    .reverse();
  for (const id of ids) {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers,
          payload: { ...fixture(), id },
        })
      ).statusCode,
    ).toBe(201);
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await app.inject({
      url: `/v1/incidents?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const page: IncidentPage & { apiVersion: number } = response.json();
    expect(page.apiVersion).toBe(1);
    expect(page.items.length).toBeLessThanOrEqual(2);
    for (const item of page.items) {
      expect(item).not.toHaveProperty('timeline');
      expect(item.failure).not.toHaveProperty('frames');
      expect(item.failure).not.toHaveProperty('summary');
      seen.push(item.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(ids);
});
test('filters services and binds cursors to the same filter', async () => {
  const { app, store } = await setup();
  for (let i = 0; i < 3; i++) await store.save({ ...fixture(), id: randomUUID() });
  await store.save({
    ...fixture(),
    id: randomUUID(),
    service: { ...fixture().service, name: 'other' },
  });
  const response = await app.inject({
    url: '/v1/incidents?limit=1&service=example-orders',
    headers,
  });
  const page: IncidentPage & { apiVersion: number } = response.json();
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.service.name).toBe('example-orders');
  expect(
    (
      await app.inject({
        url: `/v1/incidents?cursor=${page.nextCursor}&service=other`,
        headers,
      })
    ).statusCode,
  ).toBe(400);
  const empty = await app.inject({ url: '/v1/incidents?service=missing', headers });
  expect(empty.json()).toEqual({ apiVersion: 1, items: [], nextCursor: null });
});
