import pg from 'pg';
import { parsePostgresOptions, type PostgresOptions } from './postgres-options.js';

export function createPool(options: PostgresOptions) {
  const parsed = parsePostgresOptions(options);
  const pool = new pg.Pool(parsed.pool);
  // pg removes failed idle connections. Readiness and operations report safe errors.
  pool.on('error', () => {});
  return { pool, config: parsed.config };
}
