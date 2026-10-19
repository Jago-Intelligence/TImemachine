import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testCollector, headers, fixture, memoryStore } from './helpers.js';

const env = {
  WORKSPACE_AUTH_MODE: 'accounts',
  WORKSPACE_ADMIN_EMAIL: 'admin@example.test',
  WORKSPACE_ADMIN_PASSWORD: 'synthetic-admin-password',
  NOTIFICATION_ENCRYPTION_KEY: 'ab'.repeat(32),
  RATE_LIMIT_MAX: '10000',
};
const running: Awaited<ReturnType<typeof testCollector>>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((c) => c.shutdown()));
});
async function setup(store = memoryStore()) {
  const c = await testCollector(env, store);
  running.push(c);
  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    bearer: string,
    payload?: unknown,
    projectId?: string,
  ) {
    return c.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...(projectId ? { 'x-timemachine-project': projectId } : {}),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }
  async function login(
    email = env.WORKSPACE_ADMIN_EMAIL,
    password = env.WORKSPACE_ADMIN_PASSWORD,
  ) {
    return c.app.inject({
      method: 'POST',
      url: '/v1/workspace/login',
      headers,
      payload: JSON.stringify({ email, password }),
    });
  }
  const admin = (await login()).json().session as string;
  return { ...c, call, login, admin };
}

test('project boundaries apply to ingestion, lists, direct access, replay and administrative settings', async () => {
  const c = await setup();
  const a = (
    await c.call('POST', '/v1/workspace/projects', c.admin, {
      name: 'A',
      service: 'service-a',
    })
  ).json();
  const b = (
    await c.call('POST', '/v1/workspace/projects', c.admin, {
      name: 'B',
      service: 'service-b',
    })
  ).json();
  const dev = (
    await c.call('POST', '/v1/workspace/users', c.admin, {
      email: 'dev@example.test',
      password: 'synthetic-dev-password',
      role: 'developer',
      projects: [a.id],
    })
  ).json();
  const session = (await c.login('dev@example.test', 'synthetic-dev-password')).json()
    .session;
  const ta = (
    await c.call('POST', `/v1/workspace/projects/${a.id}/tokens`, c.admin, { label: 'A' })
  ).json();
  const tb = (
    await c.call('POST', `/v1/workspace/projects/${b.id}/tokens`, c.admin, { label: 'B' })
  ).json();
  const ia = {
    ...fixture(),
    id: randomUUID(),
    service: { ...fixture().service, name: 'service-a' },
  };
  const ib = {
    ...fixture(),
    id: randomUUID(),
    service: { ...fixture().service, name: 'service-b' },
  };
  expect((await c.call('POST', '/v1/incidents', ta.token, ia)).statusCode).toBe(201);
  expect((await c.call('POST', '/v1/incidents', tb.token, ib)).statusCode).toBe(201);
  expect(
    (await c.call('POST', '/v1/incidents', ta.token, { ...ib, id: randomUUID() }))
      .statusCode,
  ).toBe(403);
  for (const path of [`/v1/incidents/${ib.id}`, `/v1/incidents/${ib.id}/replays`]) {
    expect((await c.call('GET', path, session)).statusCode).toBe(404);
  }
  expect(
    (await c.call('POST', `/v1/incidents/${ib.id}/replays`, session, {})).statusCode,
  ).toBe(404);
  const list = await c.call('GET', '/v1/incidents', session);
  expect(list.statusCode).toBe(200);
  expect(list.body).toContain(ia.id);
  expect(list.body).not.toContain(ib.id);
  const issues = await c.call('GET', '/v1/issues', session);
  expect(issues.statusCode).toBe(200);
  expect(issues.body).not.toContain('service-b');
  const all = (await c.call('GET', '/v1/issues', c.admin)).json().items;
  const privateIssue = all.find(
    (item: { service: { name: string } }) => item.service.name === 'service-b',
  );
  expect(privateIssue).toBeDefined();
  expect((await c.call('GET', `/v1/issues/${privateIssue.id}`, session)).statusCode).toBe(
    404,
  );
  expect(
    (await c.call('POST', `/v1/issues/${privateIssue.id}/resolve`, session, {}))
      .statusCode,
  ).toBe(404);

  for (const path of ['/v1/workspace', '/v1/notifications', '/v1/replay/retention'])
    expect((await c.call('GET', path, session)).statusCode).toBe(403);
  expect((await c.call('GET', '/v1/incidents', ta.token)).statusCode).toBe(403);
  await c.call('DELETE', `/v1/workspace/tokens/${ta.id}`, c.admin);
  expect((await c.call('GET', '/v1/workspace/token', ta.token)).statusCode).toBe(401);
  await c.call('PUT', `/v1/workspace/users/${dev.id}`, c.admin, {
    role: 'developer',
    enabled: false,
    projects: [a.id],
  });
  expect((await c.call('GET', '/v1/workspace/me', session)).statusCode).toBe(401);
  const stored = await c.store.getWorkspace();
  expect(stored!.document).not.toContain(ta.token);
  expect(stored!.document).not.toContain(session);
  expect(stored!.document).not.toContain('synthetic-dev-password');
});

test('account throttling survives another collector and does not exhaust other accounts', async () => {
  const c = await setup();
  for (let i = 0; i < 20; i++)
    expect((await c.login('blocked@example.test', 'wrong')).statusCode).toBe(401);
  expect((await c.login('BLOCKED@example.test', 'wrong')).statusCode).toBe(429);
  const second = await setup(c.store);
  expect((await second.login('blocked@example.test', 'wrong')).statusCode).toBe(429);
  expect((await second.login()).statusCode).toBe(200);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
  try {
    expect((await second.login('blocked@example.test', 'wrong')).statusCode).toBe(401);
  } finally {
    clock.mockRestore();
  }
});

test('alert credentials are encrypted, redacted, revision protected and retained on blank updates', async () => {
  const c = await setup();
  const secret = 'https://hooks.slack.com/services/synthetic/private/credential';
  const fields = {
    ALERT_SLACK_URL: secret,
    ALERT_DASHBOARD_ORIGIN: 'https://dashboard.example.test',
  };
  const saved = await c.call('PUT', '/v1/notifications', c.admin, {
    revision: 0,
    channels: ['slack'],
    fields,
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.body).not.toContain(secret);
  expect(saved.json().configured.ALERT_SLACK_URL).toBe(true);
  const encrypted = await c.store.getNotificationSettings();
  expect(encrypted!.ciphertext).not.toContain(secret);
  expect(
    (
      await c.call('PUT', '/v1/notifications', c.admin, {
        revision: 0,
        channels: [],
        fields: {},
      })
    ).statusCode,
  ).toBe(409);
  const updated = await c.call('PUT', '/v1/notifications', c.admin, {
    revision: saved.json().revision,
    channels: [],
    fields: { ALERT_SLACK_URL: '' },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().configured.ALERT_SLACK_URL).toBe(true);
  const row = await c.store.getNotificationSettings();
  const replacement = (row!.ciphertext[0] === 'A' ? 'B' : 'A') + row!.ciphertext.slice(1);
  await c.store.saveNotificationSettings(replacement, row!.revision);
  expect((await c.call('GET', '/v1/notifications', c.admin)).statusCode).toBe(500);
});

test('last administrator cannot be disabled and logout revokes the stored session', async () => {
  const c = await setup();
  const user = (await c.call('GET', '/v1/workspace/me', c.admin)).json().user;
  expect(
    (
      await c.call('PUT', `/v1/workspace/users/${user.id}`, c.admin, {
        role: 'developer',
        enabled: false,
        projects: [],
      })
    ).statusCode,
  ).toBe(409);
  expect((await c.call('POST', '/v1/workspace/logout', c.admin)).statusCode).toBe(200);
  expect((await c.call('GET', '/v1/workspace/me', c.admin)).statusCode).toBe(401);
});

test('account login fails closed if its persistent budget cannot be saved', async () => {
  const c = await setup();
  c.store.saveWorkspace = async () => {
    throw new Error('synthetic-storage-failure');
  };
  const response = await c.login();
  expect(response.statusCode).toBeGreaterThanOrEqual(500);
  expect(response.body).not.toContain('synthetic-storage-failure');
  expect(response.body).not.toContain('ws_');
});

test('unknown identities cannot consume the reserved login capacity for real users', async () => {
  const c = await setup();
  const row = (await c.store.getWorkspace())!;
  const state = JSON.parse(row.document);
  state.loginAttempts = Array.from({ length: 1000 }, (_, index) => ({
    key: index.toString(16).padStart(64, '0'),
    count: 1,
    expiresAt: Date.now() + 60000,
  }));
  expect(await c.store.saveWorkspace(JSON.stringify(state), row.revision)).toBe(true);
  expect((await c.login('unknown@example.test', 'wrong')).statusCode).toBe(429);
  expect((await c.login()).statusCode).toBe(200);
});

test('selected projects scope admins and multi-project developers before listing and replay access', async () => {
  const c = await setup();
  const a = (
    await c.call('POST', '/v1/workspace/projects', c.admin, {
      name: 'Alpha',
      service: 'alpha-api',
    })
  ).json();
  const b = (
    await c.call('POST', '/v1/workspace/projects', c.admin, {
      name: 'Beta',
      service: 'beta-api',
    })
  ).json();
  const user = (
    await c.call('POST', '/v1/workspace/users', c.admin, {
      email: 'both@example.test',
      password: 'synthetic-both-password',
      role: 'developer',
      projects: [a.id, b.id],
    })
  ).json();
  const developer = (await c.login('both@example.test', 'synthetic-both-password')).json()
    .session;
  for (const project of [a, b]) {
    const token = (
      await c.call('POST', `/v1/workspace/projects/${project.id}/tokens`, c.admin, {
        label: project.name,
      })
    ).json().token;
    const incident = {
      ...fixture(),
      id: randomUUID(),
      service: { ...fixture().service, name: project.service },
    };
    project.incident = incident.id;
    expect((await c.call('POST', '/v1/incidents', token, incident)).statusCode).toBe(201);
  }
  const all = (await c.call('GET', '/v1/issues', c.admin)).json().items;
  const betaIssue = all.find(
    (item: { service: { name: string } }) => item.service.name === b.service,
  ).id;
  for (const session of [c.admin, developer]) {
    const list = await c.call('GET', '/v1/issues', session, undefined, a.id);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].service.name).toBe(a.service);
    expect(
      (
        await c.call('GET', `/v1/issues?service=${b.service}`, session, undefined, a.id)
      ).json().items,
    ).toHaveLength(0);
    expect(
      (await c.call('GET', `/v1/incidents/${b.incident}`, session, undefined, a.id))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await c.call(
          'GET',
          `/v1/incidents/${b.incident}/replays`,
          session,
          undefined,
          a.id,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await c.call(
          'POST',
          `/v1/incidents/${b.incident}/replays`,
          session,
          { mode: 'current' },
          a.id,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await c.call('GET', `/v1/issues/${betaIssue}`, session, undefined, a.id))
        .statusCode,
    ).toBe(404);
    expect(
      (await c.call('POST', `/v1/issues/${betaIssue}/resolve`, session, {}, a.id))
        .statusCode,
    ).toBe(404);
    expect(
      (await c.call('GET', '/v1/incidents', session, undefined, b.id)).json().items[0]
        .service.name,
    ).toBe(b.service);
  }
  expect(
    (await c.call('GET', '/v1/issues', developer, undefined, 'bad-id')).statusCode,
  ).toBe(400);
  expect(
    (await c.call('GET', '/v1/issues', developer, undefined, randomUUID())).statusCode,
  ).toBe(403);
  await c.call('PUT', `/v1/workspace/users/${user.id}`, c.admin, {
    role: 'developer',
    enabled: true,
    projects: [b.id],
  });
  expect((await c.call('GET', '/v1/issues', developer, undefined, a.id)).statusCode).toBe(
    403,
  );
});
