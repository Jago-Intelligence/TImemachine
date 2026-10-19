import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createMemoryStore } from '../src/memory.js';
import { issueId } from '../src/issues.js';
import { fixture } from './fixtures.js';
import { verifiedRun } from './resolution-fixtures.js';
it('resolves only on explicit verified evidence; retries stay resolved and a new occurrence reopens', async () => {
  const store = createMemoryStore({
    maxEntries: 20,
    maxBytes: 1048576,
    retentionMs: 60000,
  });
  const incident = fixture();
  await store.save(incident);
  const id = issueId(incident),
    input = await verifiedRun(store, incident);
  expect((await store.getIssue(id, { limit: 1 }))!.issue.status).toBe('open');
  await store.resolveIssue(id, input);
  await store.save(incident);
  const resolved = (await store.getIssue(id, { limit: 1 }))!.issue;
  expect(resolved.status).toBe('resolved');
  expect(resolved.resolution?.runId).toBe(input.runId);
  // Caller mutation must not modify the stored proof.
  resolved.resolution!.runId = randomUUID();
  expect((await store.getIssue(id, { limit: 1 }))!.issue.resolution!.runId).toBe(
    input.runId,
  );
  await store.save({ ...incident, id: randomUUID() });
  const reopened = (await store.getIssue(id, { limit: 1 }))!.issue;
  expect(reopened.status).toBe('open');
  expect(reopened.revision).toBe(input.revision + 1);
  expect(reopened.resolution?.runId).toBe(input.runId);
  await expect(store.resolveIssue(id, input)).rejects.toMatchObject({
    code: 'ISSUE_CHANGED',
  });
});
it('rejects missing proof, cross-issue proof and verification that predates a new arrival', async () => {
  const store = createMemoryStore({
    maxEntries: 20,
    maxBytes: 1048576,
    retentionMs: 60000,
  });
  const incident = fixture();
  await store.save(incident);
  const id = issueId(incident);
  await expect(
    store.resolveIssue(id, { incidentId: incident.id, runId: randomUUID(), revision: 1 }),
  ).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
  const proof = await verifiedRun(store, incident);
  const other = {
    ...incident,
    id: randomUUID(),
    service: { ...incident.service, name: 'other-api' },
  };
  await store.save(other);
  await expect(store.resolveIssue(issueId(other), proof)).rejects.toMatchObject({
    code: 'ISSUE_NOT_FOUND',
  });
  await store.save({
    ...incident,
    id: randomUUID(),
    occurredAt: '2020-01-01T00:00:00.000Z',
  });
  await expect(store.resolveIssue(id, { ...proof, revision: 2 })).rejects.toMatchObject({
    code: 'ISSUE_CHANGED',
  });
});

it('never loses reopening when resolution and ingestion race', async () => {
  const store = createMemoryStore({
    maxEntries: 20,
    maxBytes: 1048576,
    retentionMs: 60000,
  });
  const incident = fixture();
  await store.save(incident);
  const proof = await verifiedRun(store, incident),
    id = issueId(incident);
  await Promise.allSettled([
    store.resolveIssue(id, proof),
    store.save({ ...incident, id: randomUUID() }),
  ]);
  expect((await store.getIssue(id, { limit: 1 }))!.issue).toMatchObject({
    status: 'open',
    revision: 2,
  });
});
