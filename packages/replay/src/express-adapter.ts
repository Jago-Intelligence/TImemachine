import { createRecordedClients, createRecordedAxiosAdapter } from './recorded-clients.js';
import { createRecordedPostgres, type RecordedPostgres } from './recorded-postgres.js';
import { createRecordedHttpFetch } from './recorded-http.js';
import { type HttpRecording } from '@timemachine/core';
import { createHash } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { performance } from 'node:perf_hooks';
import {
  expressReplayContractSchema,
  replayCheckSchema,
  type ReplayCheck,
  replayFixtureSchema,
  replayObservationSchema,
  type ExpressReplayContract,
  type ReplayFixture,
  type ReplayObservation,
} from '@timemachine/core';

export interface ReplayRequest {
  path: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface ReplayAssertionContext {
  response: Response;
  body: unknown;
  text: string;
  request(path: string, options?: RequestInit): Promise<Response>;
}
export interface ExpressReplayScenario {
  contract: ExpressReplayContract;
  create(
    recording?: HttpRecording,
    dependencies?: {
      postgres: RecordedPostgres;
      mysql: ReturnType<typeof createRecordedClients>['mysql'];
      mongodb: ReturnType<typeof createRecordedClients>['mongodb'];
      queues: ReturnType<typeof createRecordedClients>['queues'];
      axiosAdapter: ReturnType<typeof createRecordedAxiosAdapter>;
    },
  ): Promise<{
    handler: RequestListener;
    databaseFixtureHash?: string;
    request: ReplayRequest;
    databaseChecks?(
      context: ReplayAssertionContext,
    ): Promise<ReplayCheck[]> | ReplayCheck[];
    validate?(context: ReplayAssertionContext): Promise<boolean> | boolean;
    assert(context: ReplayAssertionContext): Promise<boolean> | boolean;
    close?(): Promise<void>;
  }>;
}
let executingRecordedReplay = false;
export function defineExpressReplay(scenarios: readonly ExpressReplayScenario[]) {
  if (!scenarios.length || scenarios.length > 20)
    throw new Error('Register 1–20 replay scenarios');
  const registered = scenarios.map((scenario) => {
    const contract = expressReplayContractSchema.parse(scenario.contract);
    const contractHash = createHash('sha256')
      .update(JSON.stringify(contract))
      .update('\n')
      .update(scenario.create.toString())
      .digest('hex');
    return { create: scenario.create, contract, contractHash };
  });
  if (new Set(registered.map((row) => row.contract.profile)).size !== registered.length)
    throw new Error('Scenario IDs must be unique');
  return {
    describe() {
      return registered.map(({ contract, contractHash }) =>
        structuredClone({ ...contract, contractHash }),
      );
    },
    fixture(profile: string, artifactId: string): ReplayFixture {
      const row = registered.find((row) => row.contract.profile === profile);
      if (!row) throw new Error('Unregistered replay scenario');
      return replayFixtureSchema.parse({
        ...row.contract,
        contractHash: row.contractHash,
        runner: 'express-app-v1',
        schemaVersion: 1,
        artifactId,
      });
    },
    async execute(input: unknown): Promise<ReplayObservation> {
      const fixture = replayFixtureSchema.parse(input);
      if (fixture.runner !== 'express-app-v1')
        throw new Error('Unsupported replay runner');
      const row = registered.find((row) => row.contract.profile === fixture.profile);
      if (
        !row ||
        JSON.stringify(this.fixture(fixture.profile, fixture.artifactId)) !==
          JSON.stringify({ ...fixture, recording: undefined })
      )
        throw new Error('Replay scenario contract changed');
      if (fixture.inputMode && !fixture.recording)
        throw new Error('Missing recorded request');
      if (
        fixture.recording &&
        (fixture.recording.request.partial ||
          fixture.recording.truncated ||
          fixture.recording.dependencies.some(
            (row) => row.partial || row.result !== 'response',
          ) ||
          /[:{}*]/.test(fixture.route))
      )
        throw new Error('Incomplete recorded request');
      if (fixture.recording && executingRecordedReplay)
        throw new Error('A recorded replay is already running');
      if (fixture.recording) executingRecordedReplay = true;
      const database = createRecordedPostgres(fixture.recording?.postgres ?? []);
      const clients = createRecordedClients(fixture.recording?.operations ?? []);
      const originalFetch = globalThis.fetch;
      const mocks = fixture.recording
        ? createRecordedHttpFetch(fixture.recording)
        : undefined;
      if (mocks) globalThis.fetch = mocks.fetch;
      let app: Awaited<ReturnType<ExpressReplayScenario['create']>> | undefined;
      let server: ReturnType<typeof createServer> | undefined;
      try {
        app = await row.create(fixture.recording, {
          postgres: database,
          mysql: clients.mysql,
          mongodb: clients.mongodb,
          queues: clients.queues,
          axiosAdapter: createRecordedAxiosAdapter(
            mocks?.fetch ??
              (async () => {
                throw new Error('Missing HTTP fixtures');
              }),
          ),
        });
        if (
          fixture.inputMode === 'synthetic-postgres' &&
          app.databaseFixtureHash !== fixture.databaseFixtureHash
        )
          throw new Error('Synthetic database fixture changed');
        server = createServer(app.handler);
        const activeServer = server;
        const activeApp = app;
        await new Promise<void>((resolve, reject) => {
          activeServer.once('error', reject);
          activeServer.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Replay app unavailable');
        const origin = `http://127.0.0.1:${address.port}`;
        const request = async (path: string, options?: RequestInit) => {
          if (!path.startsWith('/') || path.startsWith('//'))
            throw new Error('Use a local test request path');
          const url = new URL(path, origin);
          if (url.origin !== origin || url.hash)
            throw new Error('Replay requests must stay inside the test app');
          return originalFetch(url, {
            ...options,
            redirect: 'manual',
            signal: AbortSignal.timeout(3000),
          });
        };
        const requestInput = fixture.recording
          ? {
              path: fixture.route,
              headers: { 'content-type': 'application/json' },
              ...(['GET', 'HEAD'].includes(fixture.method)
                ? {}
                : { body: JSON.stringify(fixture.recording.request.body) }),
            }
          : app.request;
        const requested = new URL(requestInput.path, origin);
        const routePattern =
          '^' +
          fixture.route
            .split('/')
            .map((segment) =>
              /^:[A-Za-z0-9_]+$/.test(segment)
                ? '[^/]+'
                : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            )
            .join('/') +
          '$';
        if (!new RegExp(routePattern).test(requested.pathname))
          throw new Error('Test request does not match registered route');
        const started = performance.now();
        const response = await request(requestInput.path, {
          method: fixture.method,
          ...(requestInput.headers ? { headers: requestInput.headers } : {}),
          ...(requestInput.body === undefined ? {} : { body: requestInput.body }),
        });
        const elapsed = Math.round(performance.now() - started);
        let body: unknown;
        // Bodies remain inside the sandbox and are bounded before assertion parsing.
        const reader = response.body?.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '';
        let bytes = 0;
        if (reader) {
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 32768) {
                await reader.cancel();
                throw new Error('Test response too large');
              }
              text += decoder.decode(part.value, { stream: true });
            }
          } finally {
            reader.releaseLock();
          }
        }
        text += decoder.decode();
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        const error =
          typeof body === 'object' && body !== null && 'error' in body
            ? body.error
            : undefined;
        const code =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string' &&
          /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(error.code)
            ? error.code
            : null;
        const assertionContext = { response, body, text, request };
        if (
          fixture.inputMode === 'synthetic-postgres' &&
          (!activeApp.validate || (await activeApp.validate(assertionContext)) !== true)
        )
          throw new Error('Synthetic database invariants failed');
        let passed = false;
        try {
          passed = (await activeApp.assert(assertionContext)) === true;
          mocks?.assertComplete();
        } catch {
          passed = false;
        }
        mocks?.assertComplete();
        database.assertComplete();
        clients.assertComplete();
        const databaseChecks = activeApp.databaseChecks
          ? (await activeApp.databaseChecks(assertionContext)).map((check) =>
              replayCheckSchema.parse(check),
            )
          : [];
        if (
          databaseChecks.some(
            (check) => !['database-rollback', 'database-commit'].includes(check.id),
          )
        )
          throw new Error('Invalid database checks');
        if (databaseChecks.some((check) => check.status === 'failed')) passed = false;
        const checks: ReplayCheck[] = [
          {
            id: 'response-status',
            status:
              response.status === row.contract.target.statusCode ? 'passed' : 'failed',
          },
          {
            id: 'error-code',
            status:
              (response.status >= 500 ? fixture.failureCode : code) ===
              row.contract.target.errorCode
                ? 'passed'
                : 'failed',
          },
          { id: 'business-assertions', status: passed ? 'passed' : 'failed' },
          ...databaseChecks,
        ];
        const retry = response.headers.get('retry-after');
        return replayObservationSchema.parse({
          checks,
          statusCode: response.status,
          errorCode: response.status >= 500 ? fixture.failureCode : code,
          runtimeVersion: process.versions.node,
          ...(passed ? { outcome: 'scenario-assertions-passed' } : {}),
          ...(retry && /^\d{1,3}$/.test(retry) && Number(retry) <= 300
            ? { retryAfterSeconds: Number(retry) }
            : {}),
          timeline: [
            {
              id: 'request',
              type: 'http.request',
              method: fixture.method,
              route: fixture.route,
              offsetMs: 0,
            },
            ...(response.status >= 500
              ? [
                  {
                    id: 'error',
                    type: 'error' as const,
                    code: fixture.failureCode,
                    offsetMs: elapsed,
                  },
                ]
              : []),
            {
              id: 'response',
              type: 'http.response',
              statusCode: response.status,
              offsetMs: elapsed,
            },
            {
              id: 'assertions',
              type: 'dependency',
              dependencyId: 'test-scenario',
              operation: 'verify-result',
              outcome: passed ? 'success' : 'failure',
              durationMs: Math.max(0, Math.round(performance.now() - started) - elapsed),
              offsetMs: Math.round(performance.now() - started),
            },
          ],
        });
      } finally {
        globalThis.fetch = originalFetch;
        if (fixture.recording) executingRecordedReplay = false;
        if (server)
          await new Promise<void>((resolve) => {
            server!.close(() => resolve());
            server!.closeAllConnections();
          });
        await app?.close?.();
      }
    },
  };
}
export async function runExpressReplay(
  adapter: ReturnType<typeof defineExpressReplay>,
): Promise<void> {
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    if (process.argv.includes('--describe')) {
      write(JSON.stringify(adapter.describe()));
      return;
    }
    let input = '';
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (Buffer.byteLength(input) > 65536) throw new Error('Fixture too large');
    }
    write(JSON.stringify(await adapter.execute(JSON.parse(input))));
  } catch {
    process.exitCode = 1;
  } finally {
    process.stdout.write = write;
    clearTimeout(deadline);
  }
}
