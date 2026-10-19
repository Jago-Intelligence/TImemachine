import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
const path = new URL('../.env', import.meta.url);
let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
const existing = parseEnv(text).NOTIFICATION_ENCRYPTION_KEY;
if (existing && !/^[a-fA-F0-9]{64}$/.test(existing)) {
  console.error(
    'NOTIFICATION_ENCRYPTION_KEY is invalid. Restore the original key; do not rotate it while saved settings exist.',
  );
  process.exitCode = 1;
} else {
  if (!existing) {
    text += `\nNOTIFICATION_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`;
    writeFileSync(path, text, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  console.log(
    'Notification encryption key is configured privately. Back up .env with the database. Restart the collector after applying migrations.',
  );
}
