#!/usr/bin/env node
import { backupReplayImage } from './backup.js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { replayFixtureSchema, replayAppRegistrySchema } from '@timemachine/core';
import { dockerSandboxArgs } from './index.js';
import { readReplayApps } from './registry.js';
if (process.argv[2] === 'build') {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: timemachine-replay build');
    const { buildReplayApp } = await import('./build.js');
    buildReplayApp(process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Replay build failed.');
    process.exitCode = 1;
  }
} else if (process.argv[2] === 'check') {
  try {
    const { checkReplayApp } = await import('./check.js');
    await checkReplayApp(process.argv.slice(3));
  } catch {
    console.error(
      'Application replay check failed. Check registration, Docker and the scenario assertions.',
    );
    process.exitCode = 1;
  }
} else
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command !== 'register') throw new Error('Use register');
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (
        !key ||
        ![
          '--service',
          '--image',
          '--registry',
          '--manifest',
          '--backup-repository',
        ].includes(key) ||
        !value ||
        value.startsWith('--') ||
        flags.has(key)
      )
        throw new Error('Invalid arguments');
      flags.set(key, value);
    }
    const service = flags.get('--service');
    const image = flags.get('--image');
    if (
      !service ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(service) ||
      !image ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(image)
    )
      throw new Error('Provide service and local image');
    const inspect = spawnSync(
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', image],
      { encoding: 'utf8', timeout: 5000 },
    );
    const id = inspect.status === 0 ? inspect.stdout.trim() : '';
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Local image unavailable');
    const name = `timemachine-describe-${randomUUID()}`;
    const describe = spawnSync(
      'docker',
      ['run', ...dockerSandboxArgs(name), id, '--describe'],
      { encoding: 'utf8', timeout: 12000, maxBuffer: 65536 },
    );
    if (describe.status !== 0) {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 2000 });
      throw new Error('Replay image manifest failed');
    }
    const raw: unknown = JSON.parse(describe.stdout);
    if (!Array.isArray(raw) || !raw.length || raw.length > 20)
      throw new Error('Invalid image manifest');
    const fixtures = raw.map((contract) =>
      replayFixtureSchema.parse({
        ...contract,
        schemaVersion: 1,
        runner: 'express-app-v1',
        artifactId: id,
      }),
    );
    if (
      fixtures.some(
        (fixture) => fixture.runner !== 'express-app-v1' || fixture.service !== service,
      )
    )
      throw new Error('Image service mismatch');
    const registryPath = resolve(
      flags.get('--registry') ?? '.timemachine/replay-apps.json',
    );
    let registry;
    try {
      registry = readReplayApps(registryPath);
    } catch {
      // Do not replace an existing malformed registry.
      const { existsSync } = await import('node:fs');
      if (existsSync(registryPath)) throw new Error('Invalid existing registry');
      registry = { apps: [] };
    }
    const backupRepository = flags.get('--backup-repository');
    const backup = backupRepository ? backupReplayImage(id, backupRepository) : undefined;
    const previous = registry.apps.find((app) => app.service === service);
    const app = {
      service,
      currentArtifactId: id,
      artifacts: [...new Set([id, ...(previous?.artifacts ?? [])])],
      ...(previous?.backups ? { backups: previous.backups } : {}),
      fixtures,
    };
    if (backup) {
      app.backups = [
        ...(app.backups ?? []).filter((row) => row.artifactId !== id),
        backup,
      ];
    }
    const updated = replayAppRegistrySchema.parse({
      apps: [...registry.apps.filter((app) => app.service !== service), app],
    });
    if (Buffer.byteLength(JSON.stringify(updated, null, 2) + '\n') > 262144)
      throw new Error('Registry capacity reached');
    const manifestPath = resolve(
      flags.get('--manifest') ?? `.timemachine/${service}-fixtures.json`,
    );
    for (const [path, value] of [
      [registryPath, updated],
      [manifestPath, fixtures],
    ] as const) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      renameSync(temporary, path);
    }
    console.log(
      `Registered ${service} with ${fixtures.length} reviewed replay scenarios.`,
    );
    console.log(`Collector setting: REPLAY_APPS_FILE=${registryPath}`);
    console.log(`Application fixtures: ${manifestPath}`);
    console.log(`Recorder setting: TIMEMACHINE_REPLAY_ARTIFACT_ID=${id}`);
    console.log(
      'The collector reloads valid changes to its configured registry automatically. Use these fixtures with the matching application build.',
    );
  } catch {
    console.error(
      'Replay registration failed. Check arguments, Docker, image contracts, and registry capacity (1,000 builds per service / 256 KiB file). Existing registrations are preserved; no builds are evicted or remote images pulled.',
    );
    process.exitCode = 1;
  }
