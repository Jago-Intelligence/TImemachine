import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  replayFixtureSchema,
  replayObservationSchema,
  replayBackupSchema,
  type ReplayFixture,
  type ReplayObservation,
} from '@timemachine/core';
export class ReplayExecutionError extends Error {
  constructor(
    readonly code:
      'RUNNER_UNAVAILABLE' | 'RUN_TIMEOUT' | 'INVALID_OUTPUT' | 'INTERRUPTED',
  ) {
    super(code);
  }
}
export interface ReplayExecutor {
  run(fixture: ReplayFixture): Promise<ReplayObservation>;
  close(): Promise<void>;
  hasBackup?(artifactId: string): boolean;
  imageStatus?(
    artifactId: string,
  ): Promise<'available' | 'missing' | 'unreachable' | 'restoring' | 'recovery-failed'>;
}
export function createDockerExecutor(
  artifacts: readonly string[],
  backupFor: (artifactId: string) => string | undefined = () => undefined,
): ReplayExecutor {
  // Docker API access grants control over its host. Never use an unauthenticated
  // TCP daemon; keep the existing production replay restriction in server config.
  const host = process.env.DOCKER_HOST;
  if (
    host &&
    !host.startsWith('unix://') &&
    !host.startsWith('npipe://') &&
    !host.startsWith('ssh://') &&
    !(host.startsWith('tcp://') && process.env.DOCKER_TLS_VERIFY === '1')
  )
    throw new Error('Replay requires a local, SSH, or TLS-verified Docker endpoint');
  let closed = false;
  let preparing = false;
  const recoveryAbort = new AbortController();
  let recovery: { id: string; promise: Promise<boolean> } | undefined;
  const failures = new Map<string, number>();
  function command(args: string[], timeout = 3000) {
    return new Promise<string | undefined>((resolve) => {
      execFile(
        'docker',
        args,
        { timeout, maxBuffer: 65536, signal: recoveryAbort.signal },
        (error, stdout) => resolve(error ? undefined : stdout.trim()),
      );
    });
  }
  function backup(id: string) {
    const reference = backupFor(id);
    return replayBackupSchema.safeParse({ artifactId: id, reference }).success
      ? reference
      : undefined;
  }
  async function restore(id: string, reference: string) {
    if ((await command(['pull', reference], 120000)) === undefined) return false;
    const actual = await command(['image', 'inspect', '--format', '{{.Id}}', reference]);
    return actual === id;
  }

  let current: { cancel: () => void; settled: Promise<unknown> } | undefined;
  return {
    hasBackup: (id) => !!backup(id),
    async imageStatus(artifactId) {
      if (!artifacts.includes(artifactId)) return 'missing';
      if (closed) return 'unreachable';
      if (
        (await command(['image', 'inspect', '--format', '{{.Id}}', artifactId])) ===
        artifactId
      )
        return 'available';
      if ((await command(['info', '--format', '{{.ServerVersion}}'])) === undefined)
        return 'unreachable';
      const reference = backup(artifactId);
      if (!reference) return 'missing';
      if (recovery) return 'restoring';
      const failedAt = failures.get(artifactId);
      if (failedAt && Date.now() - failedAt < 60000) return 'recovery-failed';
      failures.delete(artifactId);
      const promise = restore(artifactId, reference)
        .then((ok) => {
          if (!ok) failures.set(artifactId, Date.now());
          return ok;
        })
        .finally(() => {
          recovery = undefined;
        });
      recovery = { id: artifactId, promise };
      return 'restoring';
    },
    async run(input) {
      const fixture = replayFixtureSchema.parse(input);
      if (closed || preparing || current || !artifacts.includes(fixture.artifactId))
        throw new ReplayExecutionError('RUNNER_UNAVAILABLE');
      preparing = true;
      try {
        if (
          (await command([
            'image',
            'inspect',
            '--format',
            '{{.Id}}',
            fixture.artifactId,
          ])) !== fixture.artifactId
        ) {
          if (recovery && recovery.id !== fixture.artifactId)
            throw new ReplayExecutionError('RUNNER_UNAVAILABLE');
          const reference = backup(fixture.artifactId);
          if (
            !reference ||
            !(await (recovery?.id === fixture.artifactId
              ? recovery.promise
              : restore(fixture.artifactId, reference)))
          )
            throw new ReplayExecutionError('RUNNER_UNAVAILABLE');
        }
        if (closed) throw new ReplayExecutionError('RUNNER_UNAVAILABLE');
      } finally {
        preparing = false;
      }
      const name = `timemachine-replay-${randomUUID()}`;
      const child = spawn(
        'docker',
        [
          'run',
          ...dockerSandboxArgs(
            name,
            fixture.runner === 'express-app-v1' &&
              fixture.inputMode === 'synthetic-postgres',
          ),
          '-i',
          fixture.artifactId,
        ],
        {
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: process.env.HOME ?? '',
            ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
            ...(process.env.DOCKER_CONTEXT
              ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT }
              : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let failure: ReplayExecutionError | undefined;
      let output = '';
      let bytes = 0;
      const remove = () => {
        child.kill('SIGKILL');
        const cleanup = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
        const timer = setTimeout(() => cleanup.kill('SIGKILL'), 2000);
        timer.unref();
        cleanup.once('exit', () => clearTimeout(timer));
        cleanup.on('error', () => clearTimeout(timer));
      };
      const settled = new Promise<ReplayObservation>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            failure = new ReplayExecutionError('RUN_TIMEOUT');
            remove();
          },
          fixture.runner === 'express-app-v1' &&
            fixture.inputMode === 'synthetic-postgres'
            ? 30000
            : 12000,
        );
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8192) {
            failure = new ReplayExecutionError('INVALID_OUTPUT');
            remove();
          } else output += chunk.toString('utf8');
        });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.once('error', () => {
          clearTimeout(timer);
          reject(new ReplayExecutionError('RUNNER_UNAVAILABLE'));
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (failure) return reject(failure);
          if (code !== 0) return reject(new ReplayExecutionError('RUNNER_UNAVAILABLE'));
          try {
            resolve(replayObservationSchema.parse(JSON.parse(output)));
          } catch {
            reject(new ReplayExecutionError('INVALID_OUTPUT'));
          }
        });
      });
      current = {
        settled,
        cancel: () => {
          failure = new ReplayExecutionError('INTERRUPTED');
          remove();
        },
      };
      child.stdin.end(JSON.stringify(fixture));
      try {
        return await settled;
      } finally {
        current = undefined;
      }
    },
    async close() {
      closed = true;
      recoveryAbort.abort();
      await recovery?.promise;
      const active = current;
      active?.cancel();
      await active?.settled.catch(() => {});
    },
  };
}

export { defineExpressReplay, runExpressReplay } from './express-adapter.js';
export type {
  ExpressReplayScenario,
  ReplayAssertionContext,
  ReplayRequest,
} from './express-adapter.js';

export function dockerSandboxArgs(name: string, postgres = false): string[] {
  return [
    '--rm',
    '--pull=never',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--ipc=private',
    '--ulimit=core=0:0',
    '--ulimit=nofile=256:256',
    '--security-opt=no-new-privileges',
    postgres ? '--pids-limit=128' : '--pids-limit=64',
    '--cpus=0.5',
    postgres ? '--memory=512m' : '--memory=128m',
    postgres ? '--memory-swap=512m' : '--memory-swap=128m',
    '--user=1000:1000',
    postgres
      ? '--tmpfs=/tmp:rw,noexec,nosuid,size=256m,mode=0700,uid=1000,gid=1000'
      : '--tmpfs=/tmp:rw,noexec,nosuid,size=16m,mode=0700,uid=1000,gid=1000',
    '--name',
    name,
  ];
}
export { readReplayApps } from './registry.js';
export { createRecordedPostgres, type RecordedPostgres } from './recorded-postgres.js';
export {
  createSyntheticPostgres,
  syntheticPostgresFixtureHash,
} from './synthetic-postgres.js';
export type { SyntheticPgClient, SyntheticPgConfig } from './synthetic-postgres.js';

export { createRecordedClients, createRecordedAxiosAdapter } from './recorded-clients.js';
