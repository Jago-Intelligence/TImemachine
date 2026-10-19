import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineExpressReplay } from '../src/express-adapter.js';
import type { ExpressReplayContract } from '@timemachine/core';
vi.mock('node:http', () => ({
  createServer: () => ({
    once: vi.fn(),
    listen: (_port: number, _host: string, resolve: () => void) => resolve(),
    address: () => ({ port: 4329 }),
    close: (resolve: () => void) => resolve(),
    closeAllConnections: vi.fn(),
  }),
}));
const contract: ExpressReplayContract = {
  service: 'my-api',
  profile: 'profile-update-v1',
  scenarioVersion: 'v1',
  method: 'PATCH',
  route: '/profiles/:id',
  failureCode: 'PROFILE_UPDATE_FAILED',
  target: { statusCode: 200, errorCode: null, outcome: 'scenario-assertions-passed' },
};
const image = `sha256:${'a'.repeat(64)}`;
let body: unknown = { user: { id: 'test-user', displayName: 'Ada' } };
let status = 200;
beforeEach(() => {
  body = { user: { id: 'test-user', displayName: 'Ada' } };
  status = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
});
afterEach(() => vi.unstubAllGlobals());
function scenario(asserted = true, path = '/profiles/test-user') {
  return defineExpressReplay([
    {
      contract,
      async create() {
        return {
          handler: () => {},
          request: {
            path,
            headers: { 'content-type': 'application/json' },
            body: '{"displayName":"Ada"}',
          },
          assert: () => asserted,
        };
      },
    },
  ]);
}
it('supports an arbitrary service and route and requires positive business assertions', async () => {
  const adapter = scenario();
  const fixture = adapter.fixture(contract.profile, image);
  const actual = await adapter.execute(fixture);
  expect(actual).toMatchObject({
    statusCode: 200,
    errorCode: null,
    outcome: 'scenario-assertions-passed',
  });
  expect(JSON.stringify(actual)).not.toContain('displayName');
  const rejected = scenario(false);
  expect(
    (await rejected.execute(rejected.fixture(contract.profile, image))).outcome,
  ).toBeUndefined();
});
it('records original failures with the reviewed failure code and rejects changed contracts', async () => {
  status = 500;
  body = { error: { message: 'private diagnostics' } };
  const adapter = scenario(false);
  const fixture = adapter.fixture(contract.profile, image);
  expect(await adapter.execute(fixture)).toMatchObject({
    statusCode: 500,
    errorCode: 'PROFILE_UPDATE_FAILED',
  });
  await expect(
    adapter.execute({ ...fixture, contractHash: '0'.repeat(64) }),
  ).rejects.toThrow('contract changed');
  expect(JSON.stringify(await adapter.execute(fixture))).not.toContain(
    'private diagnostics',
  );
});
it('rejects external and mismatched route requests', async () => {
  for (const path of [
    'https://external.example/login',
    '//external.example/login',
    '/payments',
  ]) {
    const adapter = scenario(true, path);
    await expect(
      adapter.execute(adapter.fixture(contract.profile, image)),
    ).rejects.toThrow();
  }
});

it('does not follow redirects and keeps declared assertion metadata isolated', async () => {
  status = 302;
  const adapter = scenario();
  const descriptions = adapter.describe();
  descriptions[0]!.target.statusCode = 599;
  expect(adapter.describe()[0]!.target.statusCode).toBe(200);
  await adapter.execute(adapter.fixture(contract.profile, image));
  expect(fetch).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({ redirect: 'manual' }),
  );
});

it('uses recorded inputs and dependency mocks and restores fetch after the run', async () => {
  const outerFetch = vi.fn(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ quantity: 2 });
    const pricing = (await (
      await globalThis.fetch('http://127.0.0.1:4330/price')
    ).json()) as { unitCents: number };
    return Response.json({ totalCents: pricing.unitCents * 2 });
  });
  vi.stubGlobal('fetch', outerFetch);
  const adapter = defineExpressReplay([
    {
      contract: {
        ...contract,
        inputMode: 'recorded-http',
        method: 'POST',
        route: '/checkout',
      },
      async create(recording) {
        expect(recording?.request.body.quantity).toBe(2);
        return {
          handler: () => {},
          request: { path: '/ignored', body: 'ignored' },
          assert: ({ body }) => (body as { totalCents: number }).totalCents === 3000,
        };
      },
    },
  ]);
  const fixture = adapter.fixture(contract.profile, image);
  const observation = await adapter.execute({
    ...fixture,
    recording: {
      version: 1,
      policyId: 'safe-v1',
      artifactId: image,
      request: {
        method: 'POST',
        route: '/checkout',
        body: { quantity: 2 },
        partial: false,
      },
      dependencies: [
        {
          id: 'pricing',
          origin: 'http://127.0.0.1:4330',
          method: 'GET',
          route: '/price',
          statusCode: 200,
          body: { unitCents: 1500 },
          partial: false,
          result: 'response',
        },
      ],
      truncated: false,
    },
  });
  expect(observation).toMatchObject({
    statusCode: 200,
    outcome: 'scenario-assertions-passed',
  });
  expect(globalThis.fetch).toBe(outerFetch);
});

it('passes recorded PostgreSQL results into the application factory and checks query consumption', async () => {
  const { createHash } = await import('node:crypto');
  const { normalizePostgresQuery } = await import('@timemachine/core');
  const text = 'SELECT rate_per_km FROM delivery_zones WHERE zone_code = $1';
  const outer = vi.fn(async () => Response.json({ fee: 20 }));
  vi.stubGlobal('fetch', outer);
  const adapter = defineExpressReplay([
    {
      contract: {
        ...contract,
        inputMode: 'recorded-http',
        method: 'POST',
        route: '/quote',
      },
      async create(_recording, dependencies) {
        const rate = await dependencies!.postgres.query(text, ['LOCAL']);
        return {
          handler: () => {},
          request: { path: '/quote' },
          assert: ({ body }) =>
            (body as { fee: number }).fee === Number(rate.rows[0]!.rate_per_km) * 10,
        };
      },
    },
  ]);
  const fixture = adapter.fixture(contract.profile, image);
  const observation = await adapter.execute({
    ...fixture,
    recording: {
      version: 1,
      policyId: 'safe-v1',
      artifactId: image,
      request: {
        method: 'POST',
        route: '/quote',
        body: { zoneCode: 'LOCAL', distanceKm: 10 },
        partial: false,
      },
      dependencies: [],
      postgres: [
        {
          id: 'zone-rate',
          queryHash: createHash('sha256')
            .update(normalizePostgresQuery(text)!)
            .digest('hex'),
          parameters: ['LOCAL'],
          rows: [{ rate_per_km: 2 }],
          rowCount: 1,
          result: 'rows',
          partial: false,
        },
      ],
      truncated: false,
    },
  });
  expect(observation).toMatchObject({
    statusCode: 200,
    outcome: 'scenario-assertions-passed',
  });
});

it('binds synthetic fixture hashes and requires rollback invariants independently of success assertions', async () => {
  let hash = 'd'.repeat(64),
    invariant = true;
  const close = vi.fn(async () => {});
  const adapter = defineExpressReplay([
    {
      contract: {
        ...contract,
        route: '/register',
        inputMode: 'synthetic-postgres',
        databaseFixtureHash: hash,
      },
      async create() {
        return {
          handler: () => {},
          request: { path: '/register' },
          databaseFixtureHash: hash,
          validate: () => invariant,
          assert: () => status === 200,
          close,
        };
      },
    },
  ]);
  const fixture = {
    ...adapter.fixture(contract.profile, image),
    recording: {
      version: 1 as const,
      policyId: 'test',
      databaseMode: 'synthetic-postgres' as const,
      request: {
        method: 'PATCH' as const,
        route: '/register',
        body: { handle: 'tm-test-one' },
        partial: false,
      },
      dependencies: [],
      truncated: false,
    },
  };
  expect((await adapter.execute(fixture)).outcome).toBe('scenario-assertions-passed');
  status = 500;
  expect((await adapter.execute(fixture)).statusCode).toBe(500);
  invariant = false;
  await expect(adapter.execute(fixture)).rejects.toThrow('invariants failed');
  invariant = true;
  hash = 'e'.repeat(64);
  await expect(adapter.execute(fixture)).rejects.toThrow('fixture changed');
  expect(close).toHaveBeenCalledTimes(4);
});

it('reports each success-target check separately without exposing response bodies', async () => {
  const adapter = scenario();
  const passed = await adapter.execute(adapter.fixture(contract.profile, image));
  expect(passed.checks).toEqual([
    { id: 'response-status', status: 'passed' },
    { id: 'error-code', status: 'passed' },
    { id: 'business-assertions', status: 'passed' },
  ]);
  status = 500;
  const failed = scenario(false);
  const failure = await failed.execute(failed.fixture(contract.profile, image));
  expect(failure.checks).toContainEqual({ id: 'response-status', status: 'failed' });
  expect(failure.checks).toContainEqual({ id: 'business-assertions', status: 'failed' });
});
