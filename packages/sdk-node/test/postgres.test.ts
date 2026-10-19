import { expect, it, vi } from 'vitest';
import { observePostgresQuery, type PgRecordScope } from '../src/postgres.js';
import type { RecordingPolicy } from '../src/recording-policy.js';
const policy: NonNullable<RecordingPolicy['postgres']> = [
  {
    id: 'zone-rate',
    text: 'SELECT rate_per_km, currency FROM delivery_zones WHERE zone_code = $1',
    parameterFields: ['zoneCode'],
    rowFields: ['rate_per_km', 'currency'],
  },
];
function scope(): PgRecordScope {
  return {
    body: { zoneCode: 'LOCAL' },
    ended: false,
    postgres: [],
    truncated: false,
    addTimeline: vi.fn(),
  };
}
it('records approved reads and parameters without SQL text, credentials or omitted columns', async () => {
  const state = scope();
  const result = {
    command: 'SELECT',
    rowCount: 1,
    rows: [{ rate_per_km: 2, currency: 'USD', email: 'private' }],
  };
  const original = vi.fn(async () => result);
  expect(
    await observePostgresQuery(original, {}, [policy[0]!.text, ['LOCAL']], state, policy),
  ).toBe(result);
  expect(state.postgres[0]).toMatchObject({
    parameters: ['LOCAL'],
    rows: [{ rate_per_km: 2, currency: 'USD' }],
    partial: true,
  });
  expect(JSON.stringify(state.postgres)).not.toMatch(/private|SELECT|delivery_zones/);
});
it('does not persist unapproved parameter values and keeps application results unchanged', async () => {
  const state = scope(),
    result = { command: 'SELECT', rowCount: 0, rows: [] };
  expect(
    await observePostgresQuery(
      async () => result,
      {},
      [policy[0]!.text, ['private']],
      state,
      policy,
    ),
  ).toBe(result);
  expect(state.postgres[0]).toMatchObject({ parameters: [], partial: true });
});
it('records complete result rows and safe SQLSTATE errors without raw messages', async () => {
  const state = scope();
  await observePostgresQuery(
    async () => ({
      command: 'SELECT',
      rowCount: 1,
      rows: [{ rate_per_km: 2, currency: 'USD' }],
    }),
    {},
    [policy[0]!.text, ['LOCAL']],
    state,
    policy,
  );
  expect(state.postgres[0]?.partial).toBe(false);
  const error = Object.assign(new Error('private SQL details'), { code: '42P01' });
  await expect(
    observePostgresQuery(
      async () => {
        throw error;
      },
      {},
      [policy[0]!.text, ['LOCAL']],
      state,
      policy,
    ),
  ).rejects.toBe(error);
  expect(state.postgres[1]).toMatchObject({
    result: 'error',
    errorCode: '42P01',
    partial: false,
  });
  expect(JSON.stringify(state.postgres)).not.toContain('private');
});
it('passes unsupported writes and callback queries through unchanged and blocks generation', () => {
  for (const args of [
    ['DELETE FROM delivery_zones'],
    [policy[0]!.text, ['LOCAL'], () => {}],
  ]) {
    const state = scope(),
      original = vi.fn(() => 'original-return');
    expect(observePostgresQuery(original, {}, args, state, policy)).toBe(
      'original-return',
    );
    expect(state.truncated).toBe(true);
    expect(state.postgres).toHaveLength(0);
  }
});

it('observes native pg Pool-to-Client delegation once without opening a connection', async () => {
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const { installPostgresObserver } = await import('../src/postgres.js');
  const entry = resolve('../../examples/express-delivery/src/main.js');
  const require = createRequire(entry);
  const pg = require('pg');
  const clientOriginal = pg.Client.prototype.query,
    poolOriginal = pg.Pool.prototype.query;
  pg.Client.prototype.query = async () => ({
    command: 'SELECT',
    rowCount: 1,
    rows: [{ rate_per_km: 2, currency: 'USD' }],
  });
  pg.Pool.prototype.query = function (...args: unknown[]) {
    return pg.Client.prototype.query.apply(this, args);
  };
  const state = scope();
  const observer = installPostgresObserver(() => state, policy, entry);
  try {
    expect(observer.enabled).toBe(true);
    await pg.Pool.prototype.query.call({}, policy[0]!.text, ['LOCAL']);
    expect(state.postgres).toHaveLength(1);
    expect(state.postgres[0]?.partial).toBe(false);
  } finally {
    observer.restore();
    pg.Client.prototype.query = clientOriginal;
    pg.Pool.prototype.query = poolOriginal;
  }
});

it('drops oversized or invalid result snapshots without changing the original result', async () => {
  const state = scope();
  const result = {
    command: 'SELECT',
    rowCount: 1,
    rows: [{ rate_per_km: 2, currency: 'USD' }],
    fields: Array.from({ length: 25 }, () => ({ name: 'currency' })),
  };
  expect(
    await observePostgresQuery(
      async () => result,
      {},
      [policy[0]!.text, ['LOCAL']],
      state,
      policy,
    ),
  ).toBe(result);
  expect(state.postgres[0]).toMatchObject({
    rows: [],
    rowCount: null,
    result: 'omitted',
    partial: true,
  });
  expect(state.postgres[0]?.fields).toBeUndefined();
});

it('records approved joined reads with aliases and bound pagination parameters', async () => {
  const text =
    'SELECT z.rate_per_km AS rate, r.currency FROM public.delivery_zones z LEFT JOIN regions r ON z.region_id = r.id WHERE z.zone_code = $1 AND z.rate_per_km >= $2 ORDER BY z.rate_per_km DESC LIMIT $3 OFFSET $4';
  const state = scope();
  state.body = { zoneCode: 'LOCAL', minimumRate: 1, pageSize: 10, pageOffset: 0 };
  const selected = [
    {
      id: 'joined-rates',
      text,
      parameterFields: ['zoneCode', 'minimumRate', 'pageSize', 'pageOffset'],
      rowFields: ['rate', 'currency'],
    },
  ];
  const result = {
    command: 'SELECT',
    rowCount: 1,
    rows: [{ rate: 2, currency: 'USD' }],
    fields: [{ name: 'rate' }, { name: 'currency' }],
  };
  expect(
    await observePostgresQuery(
      async () => result,
      {},
      [text, ['LOCAL', 1, 10, 0]],
      state,
      selected,
    ),
  ).toBe(result);
  expect(state.postgres[0]).toMatchObject({
    parameters: ['LOCAL', 1, 10, 0],
    rows: result.rows,
    fields: ['rate', 'currency'],
    partial: false,
  });
  expect(JSON.stringify(state.postgres)).not.toContain('delivery_zones');
});

it('explicit synthetic-fixture mode passes writes through without pretending to record database state', async () => {
  const state = { ...scope(), synthetic: true };
  const original = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  await observePostgresQuery(
    original,
    {},
    ['INSERT INTO test_users (handle) VALUES ($1)', ['tm-test-one']],
    state,
    policy,
  );
  expect(original).toHaveBeenCalled();
  expect(state.postgres).toEqual([]);
  expect(state.truncated).toBe(false);
});
