import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool } from './pool.js';
import type { PostgresOptions } from './postgres-options.js';

export async function migratePostgres(options: PostgresOptions): Promise<void> {
  const { pool } = createPool({ ...options, maxConnections: 1 });
  try {
    const client = await pool.connect();
    try {
      // A session lock serializes concurrent deployers for this database.
      await client.query('SELECT pg_advisory_lock($1)', [76214031]);
      try {
        const folder = fileURLToPath(new URL('../migrations', import.meta.url));
        const known = readMigrationFiles({ migrationsFolder: folder });
        const ledger = await client.query<{ table: string | null }>(
          "SELECT to_regclass('drizzle.__drizzle_migrations') AS table",
        );
        if (ledger.rows[0]?.table) {
          const applied = await client.query<{ hash: string; created_at: string }>(
            'SELECT hash, created_at FROM drizzle.__drizzle_migrations',
          );
          for (const row of applied.rows) {
            if (
              !known.some(
                (migration) =>
                  migration.folderMillis === Number(row.created_at) &&
                  migration.hash === row.hash,
              )
            ) {
              throw new Error('Migration history does not match the repository');
            }
          }
        }
        await migrate(drizzle(client), {
          migrationsFolder: folder,
        });
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [76214031]);
      }
    } finally {
      client.release();
    }
  } catch {
    throw new Error('PostgreSQL migration failed');
  } finally {
    await pool.end();
  }
}
