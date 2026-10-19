import { backupReplayImage } from './backup.js';
import { replayAppRegistrySchema } from '@timemachine/core';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function json(path: string) {
  if (lstatSync(path).size > 65536) throw new Error('Replay configuration is too large.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function local(root: string, value: string) {
  const path = resolve(root, value),
    rel = relative(root, path);
  if (
    !value ||
    isAbsolute(value) ||
    rel === '..' ||
    rel.startsWith('../') ||
    /[\r\n\0]/.test(value)
  )
    throw new Error('Replay paths must be relative and inside this project.');
  let cursor = root;
  for (const part of rel.split('/')) {
    cursor = join(cursor, part);
    let info;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink())
      throw new Error('Replay paths must not traverse symbolic links.');
  }
  return path;
}
function atomic(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
/** Only explicitly approved application files are sent to Docker, never the whole project. */
export function buildReplayApp(root: string) {
  root = realpathSync(root);
  const settings = json(local(root, 'timemachine/replay.json'));
  if (
    settings.version !== 1 ||
    !Array.isArray(settings.files) ||
    !settings.files.length ||
    settings.files.length > 50 ||
    settings.files.some((file: unknown) => typeof file !== 'string')
  )
    throw new Error(
      'Configure version: 1 and approved files in timemachine/replay.json.',
    );
  if (typeof settings.runner !== 'string')
    throw new Error('Set runner in timemachine/replay.json.');
  local(root, settings.runner);
  const configPath = local(root, 'timemachine/config.json');
  const config = json(configPath);
  const service = config.service?.name;
  if (
    config.version !== 1 ||
    typeof service !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(service)
  )
    throw new Error('Invalid service in timemachine/config.json.');
  const registry = local(root, config.replayRegistry ?? '.timemachine/replay-apps.json');
  const manifest = local(root, 'timemachine/replay-fixtures.json');
  if (
    settings.backupRepository !== undefined &&
    (typeof settings.backupRepository !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*\/[a-z0-9][a-z0-9._\x2f-]*$/.test(
        settings.backupRepository,
      ) ||
      settings.backupRepository.length > 380)
  )
    throw new Error(
      'backupRepository must be a registry host/repository without credentials, tags, or a URL scheme.',
    );
  const stage = mkdtempSync(join(tmpdir(), 'timemachine-build-'));
  const blocked =
    /^(?:\.git|\.timemachine|node_modules|\.env.*|credentials.*|.*\.(?:pem|key|p12)|.*\.log)$/i;
  let bytes = 0,
    count = 0;
  function copy(path: string) {
    const rel = relative(root, path);
    if (!rel || rel.split('/').some((part) => blocked.test(part)))
      throw new Error(
        'Replay files include a private or excluded path. Approve only application source and dependency manifests.',
      );
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new Error('Replay files must not contain symbolic links.');
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) copy(join(path, name));
    } else if (info.isFile()) {
      bytes += info.size;
      count++;
      if (bytes > 100 * 1024 * 1024 || count > 10000)
        throw new Error('Replay source exceeds 100 MB or 10,000 files.');
      const target = join(stage, rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(path, target);
    } else throw new Error('Replay source must contain regular files only.');
  }
  try {
    for (const file of settings.files) copy(local(root, file));
    if (
      !existsSync(join(stage, settings.runner)) ||
      !existsSync(join(stage, 'package.json'))
    )
      throw new Error('Approved files must include package.json and the replay runner.');
    const pkg = json(join(stage, 'package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (
      Object.values(deps).some(
        (value) =>
          typeof value !== 'string' || /^(?:file:|link:|workspace:|\/)/.test(value),
      )
    )
      throw new Error(
        'Use installable package dependencies in this standalone project; local/workspace dependencies need a custom Docker build.',
      );
    let install = 'RUN npm ci';
    if (existsSync(join(stage, 'pnpm-lock.yaml'))) {
      if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? ''))
        throw new Error('Pin packageManager to pnpm@x.y.z in package.json.');
      install = `RUN npm install --global ${pkg.packageManager} && pnpm install --frozen-lockfile`;
    } else if (!existsSync(join(stage, 'package-lock.json')))
      throw new Error('Include package-lock.json or pnpm-lock.yaml in approved files.');
    if (
      settings.buildScript !== undefined &&
      (typeof settings.buildScript !== 'string' ||
        !/^[A-Za-z0-9:_-]+$/.test(settings.buildScript) ||
        !pkg.scripts?.[settings.buildScript])
    )
      throw new Error('buildScript must name an existing package.json script.');
    const dockerfile = `FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY . .\n${install}\n${settings.buildScript ? `RUN npm run ${settings.buildScript}\n` : ''}USER node\nENTRYPOINT ${JSON.stringify(['node', settings.runner])}\n`;
    writeFileSync(join(stage, 'Dockerfile'), dockerfile);
    const tag = `timemachine-${service.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}:local`;
    console.log(
      `Building ${service} replay image from ${count} approved files. Configure your runner before building.`,
    );
    const build = spawnSync('docker', ['build', '--tag', tag, stage], {
      stdio: 'inherit',
    });
    if (build.status !== 0)
      throw new Error(
        'Replay build failed. Check Docker Desktop and the build output. Configuration was not updated.',
      );
    mkdirSync(dirname(registry), { recursive: true });
    const register = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'register',
        '--service',
        service,
        '--image',
        tag,
        '--registry',
        registry,
        '--manifest',
        manifest,
      ],
      { cwd: root, stdio: 'inherit' },
    );
    if (register.status !== 0)
      throw new Error(
        'Image built but registration failed. Check the app factory and scenario contracts; recorder configuration was not updated.',
      );
    const apps = json(registry).apps;
    const artifact = apps.find(
      (app: { service: string }) => app.service === service,
    )?.currentArtifactId;
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact ?? ''))
      throw new Error('Registration did not return a valid artifact.');
    if (settings.backupRepository) {
      const { reference } = backupReplayImage(artifact, settings.backupRepository);
      const saved = readFileSync(registry, 'utf8');
      const updated = replayAppRegistrySchema.parse(JSON.parse(saved));
      const app = updated.apps.find((row) => row.service === service)!;
      app.backups = [
        ...(app.backups ?? []).filter((row) => row.artifactId !== artifact),
        { artifactId: artifact, reference },
      ];
      const validated = replayAppRegistrySchema.parse(updated);
      if (Buffer.byteLength(JSON.stringify(validated, null, 2) + '\n') > 262144)
        throw new Error(
          'Backup metadata exceeds registry capacity. No registrations were removed.',
        );
      if (readFileSync(registry, 'utf8') !== saved)
        throw new Error('Registry changed during backup. Retry build.');
      atomic(registry, validated);
      console.log('Replay build backed up by immutable registry digest.');
    }
    // Preserve concurrent edits rather than overwriting the initial configuration snapshot.
    const latest = json(configPath);
    if (
      latest.service?.name !== service ||
      latest.replayRegistry !== config.replayRegistry
    )
      throw new Error('Project configuration changed during build. Run build again.');
    atomic(configPath, { ...latest, replayArtifactId: artifact });
    console.log(
      'Replay image registered and config.json updated automatically. Restart the recorded app.',
    );
    console.log(
      `Load ${registry} on the collector. Valid updates to its configured registry reload automatically. A remotely hosted collector needs this registry and the matching image deployed there; local registration does not upload them.`,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
