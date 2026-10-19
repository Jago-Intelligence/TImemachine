import { expect, it } from 'vitest';
import { normalizePostgresQuery } from '../src/index.js';
it('recognizes parameterized reads and rejects writes, literals, functions and multiple statements', () => {
  expect(
    normalizePostgresQuery(
      ' SELECT rate_per_km, currency FROM delivery_zones WHERE zone_code = $1 ',
    ),
  ).toBe('select rate_per_km, currency from delivery_zones where zone_code = $1');
  for (const sql of [
    'DELETE FROM delivery_zones',
    'SELECT pg_sleep(1) FROM delivery_zones',
    "SELECT rate_per_km FROM delivery_zones WHERE zone_code = 'LOCAL'",
    'SELECT rate_per_km FROM delivery_zones; DROP TABLE delivery_zones',
    'BEGIN',
    'SELECT * FROM delivery_zones',
    'SELECT rate_per_km FROM delivery_zones FOR UPDATE',
  ])
    expect(normalizePostgresQuery(sql)).toBeUndefined();
});

it('supports qualified columns, aliases, joins, predicates and pagination', () => {
  for (const sql of [
    'SELECT u.id, p.display_name AS name FROM public.users AS u INNER JOIN profiles p ON p.user_id = u.id WHERE u.id = $1',
    'SELECT DISTINCT z.currency FROM delivery_zones z LEFT OUTER JOIN regions r ON z.region_id = r.id AND r.code = $1 WHERE (z.code IN ($2, $3) OR z.region_id IS NULL) AND z.rate >= $4 ORDER BY z.currency ASC NULLS LAST, z.code DESC LIMIT $5 OFFSET $6',
    'SELECT id FROM users WHERE id NOT IN ($1, $2) AND deleted_at IS NOT NULL LIMIT 100 OFFSET 0',
  ])
    expect(normalizePostgresQuery(sql)).toBe(sql.toLowerCase());
});

it('rejects active SQL, unsupported expressions and malformed broader reads', () => {
  for (const sql of [
    'SELECT id INTO stolen FROM users',
    'WITH removed AS (DELETE FROM users RETURNING id) SELECT id FROM removed',
    'SELECT id FROM users UNION SELECT id FROM secrets',
    'SELECT id FROM users WHERE id IN (SELECT id FROM secrets)',
    'SELECT id FROM users JOIN profiles',
    'SELECT id FROM users WHERE id = $0',
    'SELECT id FROM users WHERE id = $100',
    'SELECT id FROM users WHERE id = 42',
    'SELECT id FROM users -- comment',
    'SELECT id FROM users FOR SHARE',
    'SELECT count(id) FROM users',
    'SELECT id FROM "Users"',
    'SELECT id FROM users WHERE (id = $1',
    'SELECT id FROM users LIMIT -1',
  ])
    expect(normalizePostgresQuery(sql)).toBeUndefined();
});
