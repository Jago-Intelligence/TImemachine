import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { normalizePostgresQuery } from '@timemachine/core';
import { createRecordedPostgres } from '../src/recorded-postgres.js';
const text = 'SELECT rate_per_km, currency FROM delivery_zones WHERE zone_code = $1';
const fixture = {
  id: 'zone-rate',
  queryHash: createHash('sha256').update(normalizePostgresQuery(text)!).digest('hex'),
  parameters: ['LOCAL'],
  rows: [{ rate_per_km: 2, currency: 'USD' }],
  rowCount: 1,
  result: 'rows' as const,
  partial: false,
};
it('replays read results without a PostgreSQL connection and detects unused queries', async () => {
  const client = createRecordedPostgres([fixture]);
  expect(() => client.assertComplete()).toThrow();
  expect(await client.query(text, ['LOCAL'])).toMatchObject({
    rows: fixture.rows,
    command: 'SELECT',
    rowCount: 1,
  });
  client.assertComplete();
  await expect(client.query(text, ['LOCAL'])).rejects.toThrow();
  expect(() => client.assertComplete()).toThrow();
});
it('rejects writes, changed parameters and partial rows', async () => {
  for (const [sql, params] of [
    ['DELETE FROM delivery_zones', []],
    [text, ['OTHER']],
  ] as const)
    await expect(
      createRecordedPostgres([fixture]).query(sql, [...params]),
    ).rejects.toThrow();
  await expect(
    createRecordedPostgres([{ ...fixture, partial: true }]).query(text, ['LOCAL']),
  ).rejects.toThrow();
});
it('replays a matched SQLSTATE error while allowing the app to handle it', async () => {
  const client = createRecordedPostgres([
    { ...fixture, rows: [], rowCount: null, result: 'error', errorCode: '42P01' },
  ]);
  await expect(client.query(text, ['LOCAL'])).rejects.toMatchObject({ code: '42P01' });
  client.assertComplete();
});

it('replays ordered joined reads and multiple lookups without querying a database', async () => {
  const joined =
    'SELECT z.rate_per_km AS rate, r.currency FROM public.delivery_zones z INNER JOIN regions r ON z.region_id = r.id WHERE z.zone_code = $1 ORDER BY z.rate_per_km DESC LIMIT $2 OFFSET $3';
  const joinedFixture = {
    ...fixture,
    id: 'joined-rate',
    queryHash: createHash('sha256').update(normalizePostgresQuery(joined)!).digest('hex'),
    parameters: ['LOCAL', 10, 0],
    rows: [{ rate: 2, currency: 'USD' }],
    fields: ['rate', 'currency'],
  };
  const client = createRecordedPostgres([joinedFixture, fixture]);
  expect(await client.query(joined, ['LOCAL', 10, 0])).toMatchObject({
    rows: joinedFixture.rows,
    fields: [{ name: 'rate' }, { name: 'currency' }],
  });
  expect(await client.query(text, ['LOCAL'])).toMatchObject({ rows: fixture.rows });
  client.assertComplete();
  await expect(
    createRecordedPostgres([joinedFixture]).query(
      joined.replace('INNER JOIN', 'LEFT JOIN'),
      ['LOCAL', 10, 0],
    ),
  ).rejects.toThrow();
});
