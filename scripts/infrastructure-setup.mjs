import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  unlinkSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { URL } from 'node:url';

/** Provision local self-hosting settings. Preserve every existing nonempty value. */
export function initializeInfrastructure(root, defaults = {}) {
  const lock = join(root, '.env.setup.lock');
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx', 0o600);
  } catch {
    throw new Error(
      'Infrastructure setup is locked. Check whether another setup is running. If no setup is running, remove the stale .env.setup.lock and retry.',
    );
  }
  try {
    return provisionInfrastructure(root, defaults);
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}
function provisionInfrastructure(root, defaults) {
  const path = join(root, '.env');
  if (existsSync(path) && !lstatSync(path).isFile())
    throw new Error('Infrastructure .env must be a regular file.');
  let source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (Buffer.byteLength(source) > 65536)
    throw new Error('Infrastructure .env is too large.');
  const env = parseEnv(source);
  for (const [field, values] of [
    ['NODE_ENV', ['development', 'test', 'production']],
    ['STORAGE_DRIVER', ['memory', 'postgres']],
    ['DATABASE_SSL', ['disable', 'require']],
    ['WORKSPACE_AUTH_MODE', ['legacy', 'accounts']],
  ]) {
    if (env[field] && !values.includes(env[field]))
      throw new Error(`Invalid infrastructure setting: ${field}`);
  }
  const markerDirectory = join(root, '.timemachine');
  if (
    existsSync(markerDirectory) &&
    (lstatSync(markerDirectory).isSymbolicLink() ||
      !lstatSync(markerDirectory).isDirectory())
  )
    throw new Error('Workspace metadata must be a local directory.');
  const marker = join(markerDirectory, 'infrastructure.json');
  const protectedFields = [
    'TIMEMACHINE_AUTH_TOKEN',
    'POSTGRES_PASSWORD',
    'DASHBOARD_PASSWORD',
    'DASHBOARD_SESSION_SECRET',
    'NOTIFICATION_ENCRYPTION_KEY',
    'WORKSPACE_ADMIN_PASSWORD',
  ];
  if (existsSync(marker)) {
    let tracked;
    try {
      tracked = JSON.parse(readFileSync(marker, 'utf8')).protectedFields;
    } catch {
      throw new Error('Workspace metadata is invalid; restore its backup.');
    }
    if (
      !Array.isArray(tracked) ||
      !tracked.length ||
      tracked.some((field) => !protectedFields.includes(field))
    )
      throw new Error('Workspace metadata is invalid; restore its backup.');
    const missing = tracked.filter((field) => !env[field]);
    if (missing.length)
      throw new Error(
        `Existing workspace secrets are missing: ${missing.join(', ')}. Restore your private .env backup; setup will not regenerate them.`,
      );
  }
  const secret = (bytes = 32) => randomBytes(bytes).toString('hex');
  const port = (value, fallback, field) => {
    const number = Number(value || fallback);
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      throw new Error(`Invalid infrastructure setting: ${field}`);
    return String(number);
  };
  const collectorPort = port(env.PORT, defaults.collectorPort ?? 4318, 'PORT');
  let existingDatabase;
  if (env.DATABASE_URL) {
    try {
      existingDatabase = new URL(env.DATABASE_URL);
    } catch {
      throw new Error('Invalid infrastructure setting: DATABASE_URL');
    }
    if (!['postgres:', 'postgresql:'].includes(existingDatabase.protocol))
      throw new Error('Invalid infrastructure setting: DATABASE_URL');
  }
  const localDatabase =
    existingDatabase &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(existingDatabase.hostname);
  const databasePort = port(
    env.POSTGRES_PORT || (localDatabase ? existingDatabase.port : ''),
    defaults.databasePort ?? 55432,
    'POSTGRES_PORT',
  );
  const postgresPassword =
    env.POSTGRES_PASSWORD ||
    (localDatabase && existingDatabase.password
      ? decodeURIComponent(existingDatabase.password)
      : secret());
  if (
    localDatabase &&
    env.POSTGRES_PASSWORD &&
    existingDatabase.password &&
    decodeURIComponent(existingDatabase.password) !== env.POSTGRES_PASSWORD
  )
    throw new Error(
      'POSTGRES_PASSWORD does not match DATABASE_URL; existing settings were preserved.',
    );
  const host = env.HOST || '127.0.0.1';
  const dashboardOrigin =
    env.DASHBOARD_ORIGIN || defaults.dashboardOrigin || 'http://127.0.0.1:4321';
  const collectorUrl =
    env.TIMEMACHINE_COLLECTOR_URL ||
    `http://${host === '::1' ? '[::1]' : host}:${collectorPort}`;
  for (const [field, value] of [
    ['DASHBOARD_ORIGIN', dashboardOrigin],
    ['TIMEMACHINE_COLLECTOR_URL', collectorUrl],
    ['ALERT_DASHBOARD_ORIGIN', env.ALERT_DASHBOARD_ORIGIN || dashboardOrigin],
  ]) {
    try {
      const url = new URL(value);
      if (
        url.origin !== value ||
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (url.protocol === 'http:' &&
          !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      )
        throw new Error();
    } catch {
      throw new Error(`Invalid infrastructure setting: ${field}`);
    }
  }
  for (const [field, minimum] of [
    ['TIMEMACHINE_AUTH_TOKEN', 32],
    ['DASHBOARD_SESSION_SECRET', 32],
    ['DASHBOARD_PASSWORD', 12],
    ['WORKSPACE_ADMIN_PASSWORD', 12],
  ]) {
    if (
      env[field] &&
      (env[field].length < minimum ||
        env[field].length > 256 ||
        (!field.endsWith('PASSWORD') && /\s/.test(env[field])))
    )
      throw new Error(`Invalid infrastructure setting: ${field}`);
  }
  if (
    env.NOTIFICATION_ENCRYPTION_KEY &&
    !/^[a-fA-F0-9]{64}$/.test(env.NOTIFICATION_ENCRYPTION_KEY)
  )
    throw new Error(
      'Invalid NOTIFICATION_ENCRYPTION_KEY. Restore the original key instead of rotating it.',
    );
  const user = defaults.databaseUser ?? 'timemachine';
  const name = defaults.databaseName ?? 'timemachine';
  const databaseUrl =
    env.DATABASE_URL ||
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(postgresPassword)}@127.0.0.1:${databasePort}/${encodeURIComponent(name)}`;
  const values = {
    NODE_ENV: 'development',
    HOST: host,
    PORT: collectorPort,
    LOG_LEVEL: 'info',
    STORAGE_DRIVER: 'postgres',
    POSTGRES_PORT: databasePort,
    POSTGRES_PASSWORD: postgresPassword,
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: existingDatabase && !localDatabase ? 'require' : 'disable',
    TIMEMACHINE_AUTH_TOKEN: secret(),
    DASHBOARD_PASSWORD: secret(24),
    DASHBOARD_SESSION_SECRET: secret(),
    DASHBOARD_ORIGIN: dashboardOrigin,
    TIMEMACHINE_COLLECTOR_URL: collectorUrl,
    NOTIFICATION_ENCRYPTION_KEY: secret(),
    ALERT_DASHBOARD_ORIGIN: dashboardOrigin,
  };
  if (!existingDatabase || localDatabase) {
    const testUrl = new URL(databaseUrl);
    testUrl.pathname = '/postgres';
    values.TEST_DATABASE_URL = testUrl.href;
  }
  values.WORKSPACE_AUTH_MODE = 'accounts';
  values.WORKSPACE_ADMIN_EMAIL = 'admin@timemachine.local';
  values.WORKSPACE_ADMIN_PASSWORD = secret(24);
  const generated = [];
  for (const [field, value] of Object.entries(values)) {
    if (env[field]) continue;
    generated.push(field);
    const pattern = new RegExp(`^(?:export\\s+)?${field}\\s*=.*$`, 'm');
    const line = `${field}=${JSON.stringify(value)}`;
    source = pattern.test(source)
      ? source.replace(pattern, () => line)
      : `${source.trimEnd()}\n${line}\n`;
  }
  if (generated.length || !existsSync(path)) {
    const temporary = join(root, `.env.setup-${randomUUID()}`);
    try {
      writeFileSync(temporary, source, { flag: 'wx', mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  chmodSync(path, 0o600);
  if (
    !existsSync(marker) ||
    JSON.parse(readFileSync(marker, 'utf8')).protectedFields.length !==
      protectedFields.length
  ) {
    mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      marker,
      JSON.stringify({ version: 1, protectedFields }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
  return { generated, collectorUrl, dashboardOrigin, credentialsFile: path };
}
