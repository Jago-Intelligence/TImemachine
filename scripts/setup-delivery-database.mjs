import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import process from 'node:process';
let source = readFileSync('.env', 'utf8');
const env = { ...parseEnv(source), ...process.env };
const password = env.DELIVERY_POSTGRES_PASSWORD || randomBytes(32).toString('hex');
const port = env.DELIVERY_POSTGRES_PORT || '55435';
const values = {
  DELIVERY_POSTGRES_PASSWORD: password,
  DELIVERY_POSTGRES_PORT: port,
  DELIVERY_DATABASE_URL: `postgresql://delivery:${encodeURIComponent(password)}@127.0.0.1:${port}/delivery`,
};
for (const [key, value] of Object.entries(values)) {
  if (!env[key]) source = `${source.trimEnd()}\n${key}=${JSON.stringify(value)}\n`;
}
writeFileSync('.env.tmp', source, { mode: 0o600 });
chmodSync('.env.tmp', 0o600);
renameSync('.env.tmp', '.env');
process.stdout.write('Delivery example database settings prepared privately in .env.\n');
