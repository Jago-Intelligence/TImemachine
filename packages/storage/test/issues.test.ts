import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createMemoryStore } from '../src/memory.js';
import {
  issueId,
  parseIssueListQuery,
  parseIssueOccurrenceQuery,
} from '../src/issues.js';
import { fixture } from './fixtures.js';
const limits = { maxEntries: 100, maxBytes: 1048576, retentionMs: 60000 };
function sample(time = '2026-10-12T20:00:00.000Z') {
  return { ...fixture(), id: randomUUID(), occurredAt: time, capturedAt: time };
}
it('groups distinct requests and versions while retaining every occurrence', async () => {
  const store = createMemoryStore(limits);
  const first = sample();
  const latest = sample('2026-10-12T20:01:00.000Z');
  latest.service.version = '2.0.0';
  latest.correlation.requestId = 'different-request';
  await Promise.all([store.save(first), store.save(latest), store.save(first)]);
  const page = await store.listIssues({ limit: 25 });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    id: issueId(first),
    occurrences: 2,
    firstSeen: first.occurredAt,
    lastSeen: latest.occurredAt,
    latestIncidentId: latest.id,
  });
  const detail = await store.getIssue(issueId(first), { limit: 25 });
  expect(detail!.occurrences.items.map((row) => row.id)).toEqual([latest.id, first.id]);
  expect((await store.get(first.id))!.correlation.requestId).toBe(
    first.correlation.requestId,
  );
});
it('separates environment, service, method, route, code, error type and source location', () => {
  const base = sample();
  const variants = Array.from({ length: 7 }, () => structuredClone(base));
  variants[0]!.service.environment = 'production';
  variants[1]!.service.name = 'another-app';
  const method = variants[2]!.timeline.find((event) => event.type === 'http.request');
  if (method?.type === 'http.request') method.method = 'GET';
  const route = variants[3]!.timeline.find((event) => event.type === 'http.request');
  if (route?.type === 'http.request') route.route = '/profile';
  variants[4]!.failure.code = 'ANOTHER_FAILURE';
  variants[5]!.failure.name = 'TypeError';
  variants[6]!.failure.frames[0]!.line = 99;
  expect(new Set([base, ...variants].map(issueId)).size).toBe(8);
});
it('paginates issues with timestamp ties and binds cursors to their filter', async () => {
  const store = createMemoryStore(limits);
  for (const code of ['ERROR_A', 'ERROR_B', 'ERROR_C']) {
    const row = sample();
    row.failure.code = code;
    await store.save(row);
  }
  const first = await store.listIssues({ limit: 2 });
  const second = await store.listIssues(
    parseIssueListQuery({ limit: '2', cursor: first.nextCursor! }),
  );
  expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(3);
  expect(second.nextCursor).toBeNull();
  expect(() =>
    parseIssueListQuery({ cursor: first.nextCursor!, service: 'another-app' }),
  ).toThrow();
});
it('binds occurrence cursors to one issue and handles duplicate retries', async () => {
  const store = createMemoryStore(limits);
  const first = sample();
  const second = sample();
  await store.save(first);
  await store.save(second);
  await Promise.all(Array.from({ length: 10 }, () => store.save(first)));
  const id = issueId(first);
  const page = await store.getIssue(id, { limit: 1 });
  const next = await store.getIssue(
    id,
    parseIssueOccurrenceQuery({ limit: '1', cursor: page!.occurrences.nextCursor! }, id),
  );
  expect(next!.occurrences.items[0]!.id).not.toBe(page!.occurrences.items[0]!.id);
  expect(next!.issue.occurrences).toBe(2);
  expect(() =>
    parseIssueOccurrenceQuery({ cursor: page!.occurrences.nextCursor! }, '0'.repeat(64)),
  ).toThrow();
});
it('excludes expired occurrences and updates first seen without historical counter drift', async () => {
  let now = 0;
  const store = createMemoryStore({ ...limits, retentionMs: 1000, now: () => now });
  const first = sample();
  await store.save(first);
  now = 500;
  const second = sample('2026-10-12T20:01:00.000Z');
  await store.save(second);
  now = 1000;
  const detail = await store.getIssue(issueId(first), { limit: 25 });
  expect(detail!.issue).toMatchObject({ occurrences: 1, firstSeen: second.occurredAt });
  now = 1500;
  expect((await store.listIssues({ limit: 25 })).items).toEqual([]);
  expect(await store.getIssue(issueId(first), { limit: 25 })).toBeUndefined();
  await store.close();
  await expect(store.listIssues({ limit: 25 })).rejects.toMatchObject({
    code: 'STORE_UNAVAILABLE',
  });
});

it('combines case-insensitive search, last-seen date ranges and status before pagination', async () => {
  const { verifiedRun } = await import('./resolution-fixtures.js');
  const store = createMemoryStore(limits);
  const items = ['12', '13', '14'].map((day, index) => ({
    ...sample(`2026-10-${day}T12:00:00.000Z`),
    service: { ...fixture().service, name: `filter-api-${index}` },
  }));
  for (const incident of items) await store.save(incident);
  await store.resolveIssue(issueId(items[1]!), await verifiedRun(store, items[1]!));
  expect(
    (await store.listIssues({ limit: 1, status: 'resolved' })).items[0]!.service.name,
  ).toBe('filter-api-1');
  expect(
    (
      await store.listIssues({
        limit: 25,
        q: 'FILTER-API',
        from: '2026-10-13T00:00:00.000Z',
        to: '2026-10-14T00:00:00.000Z',
      })
    ).items,
  ).toHaveLength(1);
  expect((await store.listIssues({ limit: 25, q: "%_' OR 1=1" })).items).toEqual([]);
  const first = await store.listIssues({ limit: 1, q: 'filter-api', status: 'open' });
  expect(first.nextCursor).toBeTruthy();
  const next = parseIssueListQuery({
    limit: '1',
    q: 'filter-api',
    status: 'open',
    cursor: first.nextCursor!,
  });
  expect((await store.listIssues(next)).items[0]!.id).not.toBe(first.items[0]!.id);
  expect(() =>
    parseIssueListQuery({ q: 'changed', status: 'open', cursor: first.nextCursor! }),
  ).toThrow('mismatch');
  expect(() =>
    parseIssueListQuery({
      from: '2026-10-14T00:00:00.000Z',
      to: '2026-10-13T00:00:00.000Z',
    }),
  ).toThrow();
});
