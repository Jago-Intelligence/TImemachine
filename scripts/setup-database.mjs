import process from 'node:process';
import console from 'node:console';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
let source = '';
try {
  source = readFileSync('.env', 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const env = parseEnv(source);
if (env.DATABASE_URL) {
  console.log('Database configuration already exists; leaving .env unchanged.');
  process.exit(0);
}
const password = env.POSTGRES_PASSWORD || randomBytes(32).toString('hex');
const port = env.POSTGRES_PORT || '55432';
const values = {
  POSTGRES_PASSWORD: password,
  POSTGRES_PORT: port,
  DATABASE_URL: `postgresql://timemachine:${encodeURIComponent(password)}@127.0.0.1:${port}/timemachine`,
  TEST_DATABASE_URL: `postgresql://timemachine:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
  DATABASE_SSL: 'disable',
  STORAGE_DRIVER: 'postgres',
  ...(!env.TIMEMACHINE_AUTH_TOKEN
    ? { TIMEMACHINE_AUTH_TOKEN: randomBytes(32).toString('hex') }
    : {}),
};
for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  source = pattern.test(source)
    ? source.replace(pattern, `${key}=${JSON.stringify(value)}`)
    : `${source.trimEnd()}\n${key}=${JSON.stringify(value)}\n`;
}
writeFileSync('.env.tmp', source, { mode: 0o600 });
chmodSync('.env.tmp', 0o600);
renameSync('.env.tmp', '.env');
console.log(
  'Local PostgreSQL configuration saved privately in .env. Run pnpm db:up, then pnpm db:migrate.',
);
