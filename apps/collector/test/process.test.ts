import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixture, headers, token } from './helpers.js';

const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string')
    throw new Error('No test listener address');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function exit(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

function start(env: Record<string, string>) {
  const child = spawn(process.execPath, [entrypoint], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completed = exit(child);
  let output = '';
  child.stdout!.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr!.on('data', (data: Buffer) => {
    output += data.toString();
  });
  return { child, completed, output: () => output };
}

async function waitUntilStarted(process: ReturnType<typeof start>) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Collector startup timed out')),
      5000,
    );
    const onData = () => {
      if (process.output().includes('Incident storage is temporary')) {
        clearTimeout(timer);
        resolve();
      }
    };
    process.child.stdout!.on('data', onData);
    void process.completed.then(() => {
      clearTimeout(timer);
      reject(new Error('Collector exited during startup'));
    });
  });
}

describe('collector process lifecycle', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'serves real HTTP and exits cleanly on %s',
    async (signal) => {
      const port = await availablePort();
      const process = start({
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        TIMEMACHINE_AUTH_TOKEN: token,
        LOG_LEVEL: 'info',
      });
      const deadline = setTimeout(() => process.child.kill('SIGKILL'), 10000);
      try {
        await waitUntilStarted(process);
        const address = `http://127.0.0.1:${port}`;
        expect((await fetch(`${address}/health/ready`)).status).toBe(200);
        expect(
          (
            await fetch(`${address}/v1/incidents`, {
              method: 'POST',
              headers,
              body: JSON.stringify(fixture()),
            })
          ).status,
        ).toBe(201);
        const smoke = spawn(
          globalThis.process.execPath,
          [
            fileURLToPath(
              new URL('../../../scripts/collector-smoke.mjs', import.meta.url),
            ),
          ],
          {
            env: { PORT: String(port), TIMEMACHINE_AUTH_TOKEN: token },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        expect(await exit(smoke)).toBe(0);
        process.child.kill(signal);
        expect(await process.completed).toBe(0);
        expect(process.output()).toContain('Collector shutdown completed');
        expect(process.output()).not.toContain(token);
      } finally {
        clearTimeout(deadline);
        if (process.child.exitCode === null && process.child.signalCode === null)
          process.child.kill('SIGKILL');
        await process.completed;
      }
    },
    15000,
  );

  it.each([
    { NODE_ENV: 'test' },
    { NODE_ENV: 'production', TIMEMACHINE_AUTH_TOKEN: token },
    { NODE_ENV: 'test', PORT: 'private-invalid-port' },
  ])('fails safely before listening with unsupported configuration %j', async (env) => {
    const process = start(env);
    expect(await process.completed).toBe(1);
    expect(process.output()).toContain('STARTUP_FAILED');
    expect(process.output()).not.toContain(token);
    expect(process.output()).not.toContain('private-invalid-port');
    expect(process.output()).not.toContain('Server listening');
  });
});
