import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface SyntheticPgClient {
  connect(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}
export interface SyntheticPgConfig {
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: false;
  connectionTimeoutMillis: number;
  statement_timeout: number;
}
const execute = promisify(execFile);
export function syntheticPostgresFixtureHash(statements: readonly string[]) {
  if (
    !statements.length ||
    statements.length > 50 ||
    statements.some((sql) => !sql.trim()) ||
    Buffer.byteLength(JSON.stringify(statements)) > 65536
  )
    throw new Error('Invalid synthetic database fixtures');
  return createHash('sha256').update(JSON.stringify(statements)).digest('hex');
}

/** Start inside the reviewed network-none Docker image, never against a supplied URL. */
export async function createSyntheticPostgres(
  statements: readonly string[],
  createClient: (config: SyntheticPgConfig) => SyntheticPgClient,
  runtime: { run(file: string, args: string[]): Promise<unknown> } = {
    run: (file, args) =>
      execute(file, args, {
        timeout: 10000,
        maxBuffer: 65536,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      }),
  },
) {
  const fixtureHash = syntheticPostgresFixtureHash(statements);
  const directory = await mkdtemp('/tmp/tm-pg-');
  const data = join(directory, 'data'),
    socket = join(directory, 'socket');
  const binary = '/usr/lib/postgresql/15/bin/';
  let client: SyntheticPgClient | undefined;
  let initialized = false,
    started = false,
    closed = false,
    leased = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client?.end();
    } finally {
      try {
        if (started)
          await runtime.run(binary + 'pg_ctl', [
            '-D',
            data,
            '-m',
            'immediate',
            '-w',
            'stop',
          ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    await mkdir(socket, { mode: 0o700 });
    await runtime.run(binary + 'initdb', [
      '-D',
      data,
      '--username=timemachine',
      '--auth-local=trust',
      '--auth-host=reject',
      '--no-sync',
      '--encoding=UTF8',
      '--locale=C',
    ]);
    initialized = true;
    // No TCP listener. Data and socket both stay in disposable container tmpfs.
    started = true;
    await runtime.run(binary + 'pg_ctl', [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-k ${socket} -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10 -c fsync=off`,
      '-w',
      'start',
    ]);
    client = createClient({
      host: socket,
      port: 5432,
      user: 'timemachine',
      database: 'postgres',
      ssl: false,
      connectionTimeoutMillis: 3000,
      statement_timeout: 3000,
    });
    await client.connect();
    for (const sql of statements) await client.query(sql);
    const query = (text: string, values?: unknown[]) => {
      if (closed) return Promise.reject(new Error('Synthetic database is closed'));
      return client!.query(text, values);
    };
    return {
      fixtureHash,
      database: {
        query,
        async connect() {
          if (closed || leased)
            throw new Error('Synthetic fixture supports one transaction lease at a time');
          leased = true;
          return {
            query,
            release() {
              leased = false;
            },
          };
        },
      },
      close,
    };
  } catch {
    if (!initialized) started = false;
    await close().catch(() => {});
    throw new Error(
      'Synthetic PostgreSQL setup failed; check the reviewed replay image and fixtures',
    );
  }
}
