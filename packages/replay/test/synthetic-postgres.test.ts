import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import {
  createSyntheticPostgres,
  syntheticPostgresFixtureHash,
  type SyntheticPgConfig,
} from '../src/synthetic-postgres.js';
import { dockerSandboxArgs } from '../src/index.js';

it('creates a socket-only disposable instance, seeds reviewed fixtures and cleans up', async () => {
  const run = vi.fn<(file: string, args: string[]) => Promise<void>>(
    async () => undefined,
  );
  const client = {
    connect: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    end: vi.fn(async () => {}),
  };
  const factory = vi.fn<(config: SyntheticPgConfig) => typeof client>(() => client);
  const sql = ['CREATE TABLE test_users (id INTEGER)'];
  const sandbox = await createSyntheticPostgres(sql, factory, { run });
  const config = factory.mock.calls[0]![0];
  expect(config).toMatchObject({
    user: 'timemachine',
    database: 'postgres',
    ssl: false,
    statement_timeout: 3000,
  });
  expect(config.host).toMatch(/^\/tmp\/tm-pg-[^/]+\/socket$/);
  expect(run.mock.calls[1]![1].join(' ')).toContain("listen_addresses=''");
  expect(client.query).toHaveBeenCalledWith(sql[0]);
  const transaction = await sandbox.database.connect();
  await transaction.query('BEGIN');
  await expect(sandbox.database.connect()).rejects.toThrow('one transaction');
  transaction.release();
  await sandbox.database.query('ROLLBACK');
  expect(sandbox.fixtureHash).toBe(syntheticPostgresFixtureHash(sql));
  await sandbox.close();
  await sandbox.close();
  expect(client.end).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[2]![1]).toContain('stop');
  expect(existsSync(config.host)).toBe(false);
  await expect(sandbox.database.query('SELECT 1')).rejects.toThrow('closed');
});

it('stops the instance if fixture initialization fails and rejects oversized fixtures', async () => {
  const run = vi.fn<(file: string, args: string[]) => Promise<void>>(
    async () => undefined,
  );
  const client = {
    connect: vi.fn(async () => {}),
    query: vi.fn(async () => {
      throw new Error('bad schema');
    }),
    end: vi.fn(async () => {}),
  };
  await expect(
    createSyntheticPostgres(['invalid fixture'], () => client, { run }),
  ).rejects.toThrow('setup failed');
  expect(client.end).toHaveBeenCalled();
  expect(run.mock.calls.at(-1)![1]).toContain('stop');
  expect(() => syntheticPostgresFixtureHash(['x'.repeat(65537)])).toThrow();
  expect(syntheticPostgresFixtureHash(['SELECT 1'])).not.toBe(
    syntheticPostgresFixtureHash(['SELECT 2']),
  );
});

it('keeps database replay networkless, mountless and bounded with a larger tmpfs', () => {
  const args = dockerSandboxArgs('test', true);
  expect(args).toContain('--network=none');
  expect(args).toContain('--read-only');
  expect(args).toContain('--ipc=private');
  expect(args).toContain('--ulimit=core=0:0');
  expect(args).toContain('--ulimit=nofile=256:256');
  expect(args).toContain('--user=1000:1000');
  expect(args).toContain('--memory=512m');
  expect(args.some((arg) => arg.includes('size=256m'))).toBe(true);
  expect(args.some((arg) => arg.startsWith('--volume') || arg.startsWith('--env'))).toBe(
    false,
  );
  expect(dockerSandboxArgs('test')).toContain('--memory=128m');
});
