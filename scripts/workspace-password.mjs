import console from 'node:console';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { URL } from 'node:url';
try {
  const env = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
  if (!env.DASHBOARD_PASSWORD) throw new Error();
  if (env.WORKSPACE_AUTH_MODE === 'accounts') {
    console.log(`Initial administrator email: ${env.WORKSPACE_ADMIN_EMAIL}`);
    console.log(`Initial administrator password: ${env.WORKSPACE_ADMIN_PASSWORD}`);
    console.log(
      'If you changed the account password in the dashboard, use your new password.',
    );
  } else console.log(`Dashboard password: ${env.DASHBOARD_PASSWORD}`);
} catch {
  console.error('Dashboard credentials unavailable. Run pnpm workspace:setup first.');
  process.exitCode = 1;
}
