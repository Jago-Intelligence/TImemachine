import process from 'node:process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { createPostgresStore, migratePostgres } from '../packages/storage/dist/index.js';
const options = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL || 'require',
  ...(process.env.DATABASE_POOL_MAX
    ? { maxConnections: Number(process.env.DATABASE_POOL_MAX) }
    : {}),
  ...(process.env.DATABASE_TIMEOUT_MS
    ? { timeoutMs: Number(process.env.DATABASE_TIMEOUT_MS) }
    : {}),
  ...(process.env.DATABASE_CA_FILE
    ? { ca: readFileSync(process.env.DATABASE_CA_FILE, 'utf8') }
    : {}),
  ...(process.env.DATABASE_RETENTION_DAYS
    ? { retentionDays: Number(process.env.DATABASE_RETENTION_DAYS) }
    : {}),
};
try {
  if (process.argv[2] === 'migrate') {
    await migratePostgres(options);
    console.log('Database migrations completed.');
  } else if (process.argv[2] === 'prune') {
    const store = createPostgresStore(options);
    try {
      console.log(
        `Deleted ${await store.pruneExpired()} expired incidents (maximum 1,000 per run).`,
      );
    } finally {
      await store.close();
    }
  } else throw new Error('Unknown database command');
} catch {
  console.error(
    'Database operation failed. Check configuration, connectivity and migration history.',
  );
  process.exitCode = 1;
}
