import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { URL, URLSearchParams, fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
const root = new URL('../', import.meta.url);
const token = 'synthetic-project-smoke-control-token-123456789';
const password = 'synthetic-project-smoke-password';
const email = 'admin@project-smoke.test';
const children = [];
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
function start(args, env, cwd) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(ALERT_|SMTP_|NOTIFICATION_|REPLAY_|WORKSPACE_)/.test(key),
    ),
  );
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...base, ...env },
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    try {
      if (
        (await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(1000) })).ok
      )
        return;
    } catch {
      /* owned process startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Synthetic smoke service failed to start');
}
try {
  const collector = `http://127.0.0.1:${await port()}`;
  const origin = `http://127.0.0.1:${await port()}`;
  const collectorChild = start(
    [fileURLToPath(new URL('apps/collector/dist/main.js', root))],
    {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: new URL(collector).port,
      STORAGE_DRIVER: 'memory',
      WORKSPACE_AUTH_MODE: 'accounts',
      WORKSPACE_ADMIN_EMAIL: email,
      WORKSPACE_ADMIN_PASSWORD: password,
      TIMEMACHINE_AUTH_TOKEN: token,
      LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '10000',
    },
    fileURLToPath(root),
  );
  await ready(collector + '/health/ready', collectorChild);
  async function api(path, bearer, body, method = 'POST') {
    const response = await globalThis.fetch(collector + path, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert(response.ok, `Synthetic collector request failed: ${response.status}`);
    return response.json();
  }
  const admin = (await api('/v1/workspace/login', token, { email, password })).session;
  const a = await api('/v1/workspace/projects', admin, {
    name: 'Alpha',
    service: 'alpha-smoke-api',
  });
  const b = await api('/v1/workspace/projects', admin, {
    name: 'Beta',
    service: 'beta-smoke-api',
  });
  const developer = await api('/v1/workspace/users', admin, {
    email: 'developer@project-smoke.test',
    password,
    role: 'developer',
    projects: [a.id, b.id],
  });
  const seed = JSON.parse(
    readFileSync(
      new URL('packages/core/test/fixtures/node-http-candidate.json', root),
      'utf8',
    ),
  );
  for (const [project, code] of [
    [a, 'ALPHA_PROJECT_FAILURE'],
    [b, 'BETA_PROJECT_FAILURE'],
  ]) {
    const sdk = await api(`/v1/workspace/projects/${project.id}/tokens`, admin, {
      label: 'Synthetic smoke',
    });
    project.tokenId = sdk.id;
    project.incident = randomUUID();
    const incident = {
      ...seed,
      id: project.incident,
      service: { ...seed.service, name: project.service },
      failure: { ...seed.failure, code },
    };
    // Keep the structured error event aligned with the failure code.
    incident.timeline = incident.timeline.map((event) =>
      event.type === 'error' ? { ...event, code } : event,
    );
    await api('/v1/incidents', sdk.token, incident);
  }
  const issues = (await api('/v1/issues', admin, undefined, 'GET')).items;
  const alphaIssue = issues.find((item) => item.service.name === a.service).id;
  const require = createRequire(new URL('apps/dashboard/package.json', root));
  const dashboard = start(
    [
      require.resolve('next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      new URL(origin).port,
    ],
    {
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      WORKSPACE_AUTH_MODE: 'accounts',
      DASHBOARD_ORIGIN: origin,
      DASHBOARD_PASSWORD: password,
      DASHBOARD_SESSION_SECRET: 'synthetic-project-smoke-session-secret-123456789',
      TIMEMACHINE_AUTH_TOKEN: token,
      TIMEMACHINE_COLLECTOR_URL: collector,
    },
    fileURLToPath(new URL('apps/dashboard', root)),
  );
  await ready(origin + '/login', dashboard);
  const login = await globalThis.fetch(origin + '/auth/login', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ email: 'developer@project-smoke.test', password }),
  });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  const get = (path) =>
    globalThis.fetch(origin + path, { headers: { cookie }, redirect: 'manual' });
  const select = (projectId, requestOrigin = origin) =>
    globalThis.fetch(origin + '/api/projects/select', {
      method: 'POST',
      headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
  let html = await (await get('/')).text();
  assert(html.includes('ALPHA_PROJECT_FAILURE'));
  assert(!html.includes('BETA_PROJECT_FAILURE'));
  const changed = await select(b.id);
  assert.equal(changed.status, 200);
  const selection = changed.headers.get('set-cookie');
  assert.match(selection, /HttpOnly/i);
  assert.match(selection, /SameSite=strict/i);
  cookie += '; ' + selection.split(';')[0];
  html = await (await get('/?service=' + a.service)).text();
  assert(html.includes('BETA_PROJECT_FAILURE'));
  assert(!html.includes('ALPHA_PROJECT_FAILURE'));
  assert.equal((await get('/issues/' + alphaIssue)).status, 404);
  assert.equal((await get('/incidents/' + a.incident)).status, 404);
  assert.equal((await get('/api/incidents/' + a.incident + '/replays')).status, 404);
  const me = await (await get('/api/workspace/me')).json();
  assert.deepEqual(
    me.projects.map((project) => project.id),
    [b.id],
  );
  assert.equal((await select(randomUUID())).status, 403);
  assert.equal((await select(a.id, 'https://untrusted.example')).status, 403);
  const bad = await globalThis.fetch(origin + '/api/projects/select', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: 'x'.repeat(300),
  });
  assert.equal(bad.status, 400);
  await api(
    '/v1/workspace/users/' + developer.id,
    admin,
    { role: 'developer', enabled: true, projects: [a.id] },
    'PUT',
  );
  html = await (await get('/')).text();
  assert(html.includes('ALPHA_PROJECT_FAILURE'));
  assert(!html.includes('BETA_PROJECT_FAILURE'));
  assert.equal((await select(b.id)).status, 403);
  const adminLogin = await globalThis.fetch(origin + '/auth/login', {
    method: 'POST',
    headers: {
      origin,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
  const adminHeaders = {
    cookie: adminCookie,
    origin,
    'content-type': 'application/json',
  };
  const foreignToken = await globalThis.fetch(
    origin + `/api/workspace/projects/${b.id}/tokens`,
    {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ label: 'Rejected synthetic token' }),
    },
  );
  assert.equal(foreignToken.status, 403);
  const foreignRevoke = await globalThis.fetch(
    origin + `/api/workspace/tokens/${b.tokenId}`,
    { method: 'DELETE', headers: adminHeaders },
  );
  assert.equal(foreignRevoke.status, 404);
  const created = await globalThis.fetch(origin + '/api/workspace/projects', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'Gamma', service: 'gamma-smoke-api' }),
  });
  assert.equal(created.status, 200);
  const createdProject = await created.json();
  assert(created.headers.get('set-cookie').includes(createdProject.id));
  console.log(
    'Project dashboard smoke passed: selection, scoped lists, direct links, replay access, workspace view, CSRF and revoked membership.',
  );
} catch (error) {
  console.error(
    'Project dashboard smoke failed:',
    error instanceof Error ? error.message.slice(0, 250) : 'Unknown failure',
  );
  process.exitCode = 1;
} finally {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }),
  );
}
