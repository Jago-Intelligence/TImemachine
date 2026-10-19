import console from 'node:console';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
let source = readFileSync('.env', 'utf8');
const env = parseEnv(source);
for (const [key, value] of Object.entries({
  DASHBOARD_PASSWORD: randomBytes(24).toString('hex'),
  DASHBOARD_SESSION_SECRET: randomBytes(32).toString('hex'),
  DASHBOARD_ORIGIN: 'http://127.0.0.1:4321',
})) {
  if (!env[key]) source = `${source.trimEnd()}\n${key}=${JSON.stringify(value)}\n`;
}
writeFileSync('.env.tmp', source, { mode: 0o600 });
chmodSync('.env.tmp', 0o600);
renameSync('.env.tmp', '.env');
console.log(
  'Dashboard credentials saved privately in .env. Use DASHBOARD_PASSWORD to sign in.',
);
