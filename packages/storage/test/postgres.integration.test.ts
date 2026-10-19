import { readFileSync } from 'node:fs';
import { issueId, parseIssueOccurrenceQuery } from '../src/issues.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import pg from 'pg';
import {
  createPostgresStore,
  migratePostgres,
  type PostgresIncidentStore,
} from '../src/index.js';
import { parseIncidentListQuery } from '../src/list.js';
import { fixture } from './fixtures.js';
import { verifiedRun } from './resolution-fixtures.js';

const connection = process.env.TEST_DATABASE_URL;
if (!connection) throw new Error('TEST_DATABASE_URL is required');
const database = `tm_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({
  connectionString: connection,
  connectionTimeoutMillis: 5000,
});
const url = new URL(connection);
url.pathname = `/${database}`;
const options = { connectionString: url.toString(), ssl: 'disable' as const };
let store: PostgresIncidentStore;
let inspection: pg.Client;
beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  store = createPostgresStore(options);
  expect(await store.isReady()).toBe(false);
  await migratePostgres(options);
  await migratePostgres(options);
  expect(await store.isReady()).toBe(true);
  inspection = new pg.Client({ connectionString: options.connectionString });
  await inspection.connect();
}, 20000);
afterAll(async () => {
  await store?.close();
  await inspection?.end();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}, 10000);

test('persists incidents across pool restarts and preserves idempotency', async () => {
  const incident = fixture();
  expect(await store.save(incident)).toBe('created');
  await store.close();
  store = createPostgresStore(options);
  expect(await store.get(incident.id.toUpperCase())).toEqual(incident);
  expect(await store.save(incident)).toBe('duplicate');
  await expect(
    store.save({ ...incident, service: { ...incident.service, name: 'changed' } }),
  ).rejects.toMatchObject({ code: 'INCIDENT_CONFLICT' });
  expect(await store.get(incident.id)).toEqual(incident);
});
test('concurrent retries create a single record', async () => {
  const incident = { ...fixture(), id: randomUUID() };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => store.save(incident)),
  );
  expect(results.filter((result) => result === 'created')).toHaveLength(1);
  expect(results.filter((result) => result === 'duplicate')).toHaveLength(7);
});
test('expired incidents are hidden and explicitly pruned', async () => {
  const incident = { ...fixture(), id: randomUUID() };
  await store.save(incident);
  await inspection.query(
    "UPDATE timemachine_incidents SET received_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1",
    [incident.id],
  );
  expect(await store.get(incident.id)).toBeUndefined();
  expect(await store.pruneExpired()).toBe(1);
  expect(await store.save(incident)).toBe('created');
});
test('closed adapters reject writes and report unavailable', async () => {
  const closed = createPostgresStore(options);
  await closed.close();
  expect(await closed.isReady()).toBe(false);
  await expect(closed.save(fixture())).rejects.toMatchObject({
    code: 'STORE_UNAVAILABLE',
  });
});
test('collector HTTP ingestion survives a process restart', async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const token = 'synthetic-storage-test-token-123456789';
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const base = `http://127.0.0.1:${port}`;
  async function start() {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../../apps/collector/dist/main.js', import.meta.url))],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          HOST: '127.0.0.1',
          STORAGE_DRIVER: 'postgres',
          DATABASE_URL: options.connectionString,
          DATABASE_SSL: 'disable',
          TIMEMACHINE_AUTH_TOKEN: token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.resume();
    const deadline = Date.now() + 10000;
    while (!output.includes('Server listening')) {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error('Collector did not start');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return child;
  }
  async function stop(child: Awaited<ReturnType<typeof start>>) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    expect(code).toBe(0);
  }
  const incident = { ...fixture(), id: randomUUID() };
  let child = await start();
  try {
    expect(
      (
        await fetch(`${base}/v1/incidents`, {
          method: 'POST',
          headers,
          body: JSON.stringify(incident),
        })
      ).status,
    ).toBe(201);
    await stop(child);
    child = await start();
    const response = await fetch(`${base}/v1/incidents/${incident.id}`, { headers });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).toContain(incident.id);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  } finally {
    if (child.exitCode === null) await stop(child);
  }
}, 30000);

test('lists filtered incidents with stable keyset pagination and excludes expiry', async () => {
  const incident = fixture();
  const service = { ...incident.service, name: 'list-test' };
  const ids = Array.from({ length: 5 }, () => randomUUID())
    .sort()
    .reverse();
  for (const id of ids) await store.save({ ...incident, id, service });
  const expired = randomUUID();
  await store.save({ ...incident, id: expired, service });
  await inspection.query(
    "UPDATE timemachine_incidents SET received_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1",
    [expired],
  );
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await store.list(
      parseIncidentListQuery({
        limit: '2',
        service: service.name,
        ...(cursor ? { cursor } : {}),
      }),
    );
    seen.push(...page.items.map(({ id }) => id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(ids);
  expect(await store.list({ limit: 25, service: 'nonexistent' })).toEqual({
    items: [],
    nextCursor: null,
  });
});

test('groups concurrent PostgreSQL occurrences and matches legacy migration fingerprints', async () => {
  const first = { ...fixture(), id: randomUUID() };
  first.service.name = 'grouping-integration';
  const second = { ...structuredClone(first), id: randomUUID() };
  await Promise.all([store.save(first), store.save(second), store.save(first)]);
  const page = await store.listIssues({ limit: 25, service: first.service.name });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.occurrences).toBe(2);
  const id = issueId(first);
  const detail = await store.getIssue(id, { limit: 1 });
  expect(detail!.occurrences.nextCursor).toBeTruthy();
  const next = await store.getIssue(
    id,
    parseIssueOccurrenceQuery(
      { limit: '1', cursor: detail!.occurrences.nextCursor! },
      id,
    ),
  );
  expect(next!.occurrences.items[0]!.id).not.toBe(detail!.occurrences.items[0]!.id);
  const migration = readFileSync(
    new URL('../migrations/0003_group_incidents_into_issues.sql', import.meta.url),
    'utf8',
  );
  const edge = { ...fixture(), id: randomUUID() };
  edge.service.name = 'grouping-integration-edge';
  edge.failure.name = 'Érror:test';
  delete edge.failure.code;
  edge.failure.frames = [];
  edge.failure.source = 'unhandled-error';
  edge.timeline = edge.timeline.filter((event) => event.type === 'error');
  edge.replay = { status: 'unsupported', reason: 'missing-fixtures' };
  await store.save(edge);
  await inspection.query(migration.split('--> statement-breakpoint')[1]!);
  const edgeRow = await inspection.query(
    'SELECT issue_id FROM timemachine_incidents WHERE id = $1',
    [edge.id],
  );
  expect(edgeRow.rows[0].issue_id).toBe(issueId(edge));
  const result = await inspection.query(
    'SELECT issue_id FROM timemachine_incidents WHERE id = $1',
    [first.id],
  );
  expect(result.rows[0].issue_id).toBe(id);
  const restarted = createPostgresStore(options);
  try {
    expect((await restarted.getIssue(id, { limit: 25 }))!.issue.occurrences).toBe(2);
  } finally {
    await restarted.close();
  }
});

test('persists resolution evidence and reopens atomically on a new occurrence', async () => {
  const incident = { ...fixture(), id: randomUUID() };
  incident.service.name = 'resolution-integration';
  await store.save(incident);
  const id = issueId(incident),
    input = await verifiedRun(store, incident);
  await store.resolveIssue(id, input);
  const restarted = createPostgresStore(options);
  try {
    expect((await restarted.getIssue(id, { limit: 1 }))!.issue.status).toBe('resolved');
    await restarted.save(incident);
    expect((await restarted.getIssue(id, { limit: 1 }))!.issue.status).toBe('resolved');
    await restarted.save({ ...incident, id: randomUUID() });
    const reopened = (await restarted.getIssue(id, { limit: 1 }))!.issue;
    expect(reopened.status).toBe('open');
    expect(reopened.resolution!.runId).toBe(input.runId);
    await expect(
      restarted.resolveIssue(id, { ...input, revision: reopened.revision }),
    ).rejects.toMatchObject({ code: 'ISSUE_CHANGED' });
  } finally {
    await restarted.close();
  }
});

test('concurrent resolution and new ingestion cannot leave the issue resolved', async () => {
  const incident = { ...fixture(), id: randomUUID() };
  incident.service.name = 'resolution-race';
  await store.save(incident);
  const id = issueId(incident),
    proof = await verifiedRun(store, incident);
  const results = await Promise.allSettled([
    store.resolveIssue(id, proof),
    store.save({ ...incident, id: randomUUID() }),
  ]);
  expect(results[1]!.status).toBe('fulfilled');
  expect((await store.getIssue(id, { limit: 1 }))!.issue).toMatchObject({
    status: 'open',
    revision: 2,
  });
});

test('filters PostgreSQL groups with literal search, status and UTC last-seen boundaries', async () => {
  const first = {
    ...fixture(),
    id: randomUUID(),
    occurredAt: '2026-10-13T12:00:00.000Z',
    capturedAt: '2026-10-13T12:00:00.050Z',
  };
  first.service.name = 'filter-integration';
  const second = {
    ...structuredClone(first),
    id: randomUUID(),
    service: { ...first.service, name: 'filter-integration-other' },
    occurredAt: '2026-10-14T12:00:00.000Z',
    capturedAt: '2026-10-14T12:00:00.050Z',
  };
  await store.save(first);
  await store.save(second);
  const proof = await verifiedRun(store, first);
  await store.resolveIssue(issueId(first), proof);
  const selected = await store.listIssues({
    limit: 1,
    q: 'FILTER-INTEGRATION',
    status: 'resolved',
    from: '2026-10-13T00:00:00.000Z',
    to: '2026-10-14T00:00:00.000Z',
  });
  expect(selected.items.map((row) => row.id)).toEqual([issueId(first)]);
  expect((await store.listIssues({ limit: 25, q: "%_' OR 1=1" })).items).toEqual([]);
});

test('rejects altered migration history', async () => {
  await inspection.query("UPDATE drizzle.__drizzle_migrations SET hash = 'altered'");
  await expect(migratePostgres(options)).rejects.toThrow('PostgreSQL migration failed');
});
