import console from 'node:console';
import process from 'node:process';
import { spawn } from 'node:child_process';
const mode = process.argv[2];
if (!['dev', 'start'].includes(mode)) throw new Error('Unknown dashboard command');
if (
  !process.env.DASHBOARD_PASSWORD ||
  !process.env.DASHBOARD_SESSION_SECRET ||
  !process.env.TIMEMACHINE_AUTH_TOKEN
) {
  console.error(
    'Dashboard configuration is missing. Run pnpm setup:dashboard and configure the collector token.',
  );
  process.exit(1);
}
const child = spawn('pnpm', ['--filter', '@timemachine/dashboard', mode], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TIMEMACHINE_COLLECTOR_URL:
      process.env.TIMEMACHINE_COLLECTOR_URL ||
      `http://127.0.0.1:${process.env.PORT || '4318'}`,
    NODE_ENV: mode === 'dev' ? 'development' : 'production',
    NEXT_TELEMETRY_DISABLED: '1',
  },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
