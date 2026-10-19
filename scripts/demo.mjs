import { ensureDemoProjectToken } from './demo-project-token.mjs';
import console from 'node:console';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { URL, fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
const root = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
let stopping = false;
let failed = false;
function launch(command, args, env = process.env) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  children.add(child);
  child.completed = new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  }).then((code) => {
    children.delete(child);
    return code;
  });
  return child;
}
function signal(child, name) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(name);
    else if (child.pid) process.kill(-child.pid, name);
  } catch {
    /* The owned process already exited. */
  }
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const active = [...children];
  for (const child of active) signal(child, 'SIGTERM');
  const timer = setTimeout(() => {
    for (const child of active) signal(child, 'SIGKILL');
  }, 10000);
  await Promise.all(active.map((child) => child.completed));
  clearTimeout(timer);
}
for (const name of ['SIGINT', 'SIGTERM'])
  process.on(name, () => {
    void shutdown();
  });
async function run(command, args, env, timeout = 120000) {
  if (stopping) throw new Error('Startup cancelled');
  const child = launch(command, args, env);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signal(child, 'SIGKILL');
  }, timeout);
  const code = await child.completed;
  clearTimeout(timer);
  if (code !== 0 || timedOut || stopping) throw new Error('Demo startup step failed');
}
function port(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error('Invalid demo port');
  return number;
}
async function occupied(number) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: number });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}
function localDatabase(value, number, name) {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    Number(url.port || 5432) !== number ||
    url.pathname !== `/${name}` ||
    url.search ||
    url.hash
  )
    throw new Error('Demo requires its local Compose database settings');
}
async function ready(url, child, expected) {
  const deadline = Date.now() + 30000;
  while (!stopping && children.has(child) && Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url, {
        redirect: 'manual',
        signal: globalThis.AbortSignal.timeout(1000),
      });
      if (response.status === expected) return;
    } catch {
      /* The owned service is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('A demo service did not become ready');
}
try {
  console.log('Preparing the local TimeMachine + Express demo…');
  await run(process.execPath, ['scripts/setup-infrastructure.mjs']);
  await run(process.execPath, ['scripts/setup-delivery-database.mjs']);
  const env = {
    ...parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8')),
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  const collectorPort = port(env.PORT, 4318);
  const expressPort = 4322;
  const origin = new URL(env.DASHBOARD_ORIGIN || 'http://127.0.0.1:4321');
  const dashboardPort = port(origin.port, 4321);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error('Demo dashboard origin must be loopback HTTP');
  if (new Set([collectorPort, dashboardPort, expressPort, 4330]).size !== 4)
    throw new Error('Demo application ports must be distinct');
  if (env.STORAGE_DRIVER !== 'postgres')
    throw new Error('Demo requires PostgreSQL incident storage');
  localDatabase(env.DATABASE_URL, port(env.POSTGRES_PORT, 55432), 'timemachine');
  if (env.TIMEMACHINE_COLLECTOR_URL) {
    const url = new URL(env.TIMEMACHINE_COLLECTOR_URL);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.protocol !== 'http:' ||
      Number(url.port || 80) !== collectorPort ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error('Demo collector URL must match the local collector');
  }
  for (const [name, number] of [
    ['collector', collectorPort],
    ['dashboard', dashboardPort],
    ['Express delivery API', expressPort],
    ['pricing service', 4330],
  ])
    if (await occupied(number))
      throw new Error(
        `Stop the existing ${name} process on port ${number}, then run pnpm demo again`,
      );
  await run('docker', ['info', '--format', '{{.ServerVersion}}'], undefined, 10000);
  await run('pnpm', ['db:up'], env);
  localDatabase(
    env.DELIVERY_DATABASE_URL,
    port(env.DELIVERY_POSTGRES_PORT, 55435),
    'delivery',
  );
  if (port(env.DELIVERY_POSTGRES_PORT, 55435) === port(env.POSTGRES_PORT, 55432))
    throw new Error('Delivery and collector database ports must differ');
  await run(
    'docker',
    [
      'compose',
      '--env-file',
      '.env',
      '-p',
      'timemachine-delivery',
      '-f',
      'infra/delivery-database.yml',
      'up',
      '-d',
      '--wait',
      'delivery-db',
    ],
    env,
  );
  await run('pnpm', ['build']);
  await run(process.execPath, ['scripts/build-replay.mjs'], env, 300000);
  const registryPath = fileURLToPath(
    new URL('../.timemachine/delivery-replay-apps.json', import.meta.url),
  );
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const registered = registry.apps.find((app) => app.service === 'delivery-api');
  if (!registered) throw new Error('Delivery replay registration missing');
  env.REPLAY_APPS_FILE = registryPath;
  delete env.REPLAY_IMAGE_ID;
  delete env.REPLAY_IMAGE_IDS;
  env.TIMEMACHINE_REPLAY_ARTIFACT_ID = registered.currentArtifactId;
  env.TIMEMACHINE_RECORDING_POLICY = fileURLToPath(
    new URL('../examples/express-delivery/recording-policy.json', import.meta.url),
  );
  env.TIMEMACHINE_SERVICE_NAME = 'delivery-api';
  env.TIMEMACHINE_SERVICE_VERSION = '1.0.0';
  env.TIMEMACHINE_COLLECTOR_URL = `http://127.0.0.1:${collectorPort}`;
  await run(process.execPath, ['scripts/database.mjs', 'migrate'], env);
  const collector = launch(process.execPath, ['apps/collector/dist/main.js'], {
    ...env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
  });
  await ready(`http://127.0.0.1:${collectorPort}/health/ready`, collector, 200);
  const projectToken = await ensureDemoProjectToken(
    env,
    'delivery-api',
    fileURLToPath(
      new URL('../.timemachine/demo-project-credentials.json', import.meta.url),
    ),
  );
  const appEnv = {
    ...env,
    TIMEMACHINE_AUTH_TOKEN: projectToken,
    NODE_ENV: 'development',
  };
  for (const key of Object.keys(appEnv))
    if (
      key.startsWith('WORKSPACE_') ||
      key.startsWith('DASHBOARD_') ||
      key.startsWith('ALERT_') ||
      key.startsWith('SMTP_') ||
      key === 'NOTIFICATION_ENCRYPTION_KEY' ||
      key === 'DATABASE_URL' ||
      key === 'POSTGRES_PASSWORD' ||
      key === 'TEST_DATABASE_URL'
    )
      delete appEnv[key];
  const express = launch(
    process.execPath,
    [
      '--import',
      './packages/sdk-node/dist/automatic-preload.js',
      'examples/express-delivery/src/main.js',
    ],
    appEnv,
  );
  await ready(`http://127.0.0.1:${expressPort}/health`, express, 200);
  const require = createRequire(
    new URL('../apps/dashboard/package.json', import.meta.url),
  );
  const dashboard = launch(
    process.execPath,
    [
      require.resolve('next/dist/bin/next'),
      'start',
      fileURLToPath(new URL('../apps/dashboard', import.meta.url)),
      '--hostname',
      '127.0.0.1',
      '--port',
      String(dashboardPort),
    ],
    {
      ...env,
      NODE_ENV: 'production',
      TIMEMACHINE_COLLECTOR_URL: `http://127.0.0.1:${collectorPort}`,
    },
  );
  await ready(`${origin.origin}/login`, dashboard, 200);
  console.log(
    `\nReady: ${origin.origin}\nSign in with WORKSPACE_ADMIN_EMAIL and the initial WORKSPACE_ADMIN_PASSWORD from .env (legacy mode uses DASHBOARD_PASSWORD).\nDelivery test page: http://127.0.0.1:4322
Use Calculate delivery fee, then replay the delivery-api incident.
After fixing RATE_FIELD in examples/express-delivery/src/app.js, stop and rerun pnpm demo.\nCtrl+C stops these app processes. Databases and saved data remain available.\n`,
  );
  await Promise.race([collector.completed, express.completed, dashboard.completed]);
  if (!stopping) {
    failed = true;
    console.error('A demo application stopped. Stopping the remaining owned processes.');
  }
} catch (error) {
  if (!stopping) {
    failed = true;
    const message =
      error instanceof Error && error.message.startsWith('Stop the existing ')
        ? error.message
        : 'Demo startup failed. Check Docker Desktop, local .env configuration and the step output above.';
    console.error(message);
  }
} finally {
  await shutdown();
  process.exitCode = failed ? 1 : 0;
}
