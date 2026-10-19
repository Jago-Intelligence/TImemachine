import process from 'node:process';
import console from 'node:console';
import { spawnSync } from 'node:child_process';
if (!process.env.TEST_DATABASE_URL) {
  console.error(
    'TEST_DATABASE_URL is required; use a dedicated PostgreSQL test server with permission to create temporary databases.',
  );
  process.exit(1);
}
const result = spawnSync(
  'pnpm',
  ['--filter', '@timemachine/storage', 'test:integration'],
  { stdio: 'inherit', env: process.env },
);
process.exit(result.status ?? 1);
