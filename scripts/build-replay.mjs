import process from 'node:process';
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, timeout = 240000) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout });
  if (result.status !== 0) throw new Error('Replay preparation failed');
}
try {
  run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@timemachine/replay...']);
  run('docker', [
    'build',
    '-f',
    'infra/delivery-replay.Dockerfile',
    '-t',
    'timemachine-delivery-replay:local',
    '.',
  ]);
  run(
    process.execPath,
    [
      'packages/replay/dist/cli.js',
      'register',
      '--service',
      'delivery-api',
      '--image',
      'timemachine-delivery-replay:local',
      '--registry',
      '.timemachine/delivery-replay-apps.json',
      '--manifest',
      '.timemachine/delivery-fixtures.json',
    ],
    20000,
  );
  console.log(
    'Delivery replay build registered. pnpm demo supplies its recorder settings automatically.',
  );
} catch {
  console.error(
    'Delivery replay build failed. Check Docker Desktop and the build output above.',
  );
  process.exitCode = 1;
}
