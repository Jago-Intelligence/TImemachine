import { expect, test } from 'vitest';
import { parsePostgresOptions } from '../src/postgres-options.js';
const connectionString = 'postgresql://user:private-password@localhost/db';
test('verifies TLS and bounds database operations by default', () => {
  const { pool } = parsePostgresOptions({ connectionString });
  expect(pool.ssl).toEqual({ rejectUnauthorized: true });
  expect(pool.statement_timeout).toBe(5000);
  expect(pool.connectionTimeoutMillis).toBe(5000);
});
test('requires explicit local TLS opt-out', () => {
  expect(parsePostgresOptions({ connectionString, ssl: 'disable' }).pool.ssl).toBe(false);
});
test.each(['?sslmode=no-verify', '?statement_timeout=0'])(
  'rejects URL overrides %s',
  (query) => {
    expect(() =>
      parsePostgresOptions({ connectionString: connectionString + query }),
    ).toThrow('configure connection options separately');
  },
);
test('does not expose passwords in configuration errors', () => {
  expect(() => parsePostgresOptions({ connectionString, maxConnections: 0 })).toThrow(
    'Invalid PostgreSQL configuration',
  );
});
