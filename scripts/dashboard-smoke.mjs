import { URL, URLSearchParams } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import console from 'node:console';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const token = 'synthetic-dashboard-collector-token-123456789';
const password = 'synthetic-dashboard-password-only';
const secret = 'synthetic-dashboard-session-secret-123456789';
const children = [];
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}
async function waitFor(url, child) {
  const end = Date.now() + 30000;
  while (Date.now() < end && child.exitCode === null) {
    try {
      const response = await globalThis.fetch(url, {
        redirect: 'manual',
        signal: globalThis.AbortSignal.timeout(1000),
      });
      if (response.status === 200) return;
    } catch {
      /* Wait for the owned process to listen. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Dashboard smoke process did not start');
}
function start(args, env, cwd) {
  const child = spawn(process.execPath, args, {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(ALERT_|SMTP_|NOTIFICATION_|REPLAY_|WORKSPACE_)/.test(key),
        ),
      ),
      ...env,
    },
    cwd,
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}
try {
  const collectorPort = await freePort();
  const dashboardPort = await freePort();
  const collector = `http://127.0.0.1:${collectorPort}`;
  const origin = `http://127.0.0.1:${dashboardPort}`;
  const collectorChild = start(
    [fileURLToPath(new URL('apps/collector/dist/main.js', root))],
    {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(collectorPort),
      STORAGE_DRIVER: 'memory',
      TIMEMACHINE_AUTH_TOKEN: token,
      LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '1000',
    },
    fileURLToPath(root),
  );
  await waitFor(`${collector}/health/ready`, collectorChild);
  const require = createRequire(new URL('apps/dashboard/package.json', root));
  const dashboardChild = start(
    [
      require.resolve('next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(dashboardPort),
    ],
    {
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      DASHBOARD_ORIGIN: origin,
      DASHBOARD_PASSWORD: password,
      DASHBOARD_SESSION_SECRET: secret,
      TIMEMACHINE_AUTH_TOKEN: token,
      TIMEMACHINE_COLLECTOR_URL: collector,
    },
    fileURLToPath(new URL('apps/dashboard', root)),
  );
  await waitFor(`${origin}/login`, dashboardChild);
  const get = (path, cookie) =>
    globalThis.fetch(origin + path, {
      redirect: 'manual',
      headers: cookie ? { cookie } : {},
    });
  const loginPage = await get('/login');
  const policy = loginPage.headers.get('content-security-policy');
  assert(policy?.includes("'strict-dynamic'"));
  assert(!policy.includes('unsafe-eval'));
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  assert(nonce);
  const html = await loginPage.text();
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
  assert(scripts.length > 0);
  for (const [, attributes] of scripts) assert(attributes.includes(`nonce="${nonce}"`));
  const nextPage = await get('/login');
  assert.notEqual(nextPage.headers.get('content-security-policy'), policy);
  const login = (value, requestOrigin = origin) =>
    globalThis.fetch(origin + '/auth/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        origin: requestOrigin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ password: value }),
    });
  const anonymous = await get('/');
  assert.equal(anonymous.status, 307);
  assert.equal(anonymous.headers.get('location'), '/login');
  assert.equal((await get('/incidents/' + randomUUID())).status, 307);
  assert.equal((await login(password, 'https://untrusted.example')).status, 403);
  const wrong = await login('wrong');
  assert.equal(wrong.status, 303);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const jsonLogin = await globalThis.fetch(origin + '/auth/login', {
    method: 'POST',
    headers: {
      origin,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ password }),
  });
  assert.equal(jsonLogin.status, 200);
  assert.deepEqual(await jsonLogin.json(), { ok: true });
  const jsonCookie = jsonLogin.headers.get('set-cookie')?.split(';')[0];
  assert(jsonCookie);
  const jsonLogout = await globalThis.fetch(origin + '/auth/logout', {
    method: 'POST',
    headers: { origin, accept: 'application/json', cookie: jsonCookie },
  });
  assert.equal(jsonLogout.status, 200);
  assert.match(jsonLogout.headers.get('set-cookie') ?? '', /Max-Age=0/i);
  const signedIn = await login(password);
  assert.equal(signedIn.status, 303);
  const setCookie = signedIn.headers.get('set-cookie');
  assert(setCookie);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=strict/i);
  const cookie = setCookie.split(';')[0];
  assert(cookie);
  const empty = await get('/', cookie);
  assert.equal(empty.status, 200);
  assert.match(await empty.text(), /Your story starts with the first capture/);
  const incident = JSON.parse(
    readFileSync(
      new URL('packages/core/test/fixtures/node-http-candidate.json', root),
      'utf8',
    ),
  );
  incident.id = randomUUID();
  incident.service.name = 'dashboard-fixture';
  incident.service.version = '<script>dangerous()</script>';
  assert.equal(
    (
      await globalThis.fetch(collector + '/v1/incidents', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(incident),
      })
    ).status,
    201,
  );
  const list = await get('/?service=dashboard-fixture', cookie);
  assert.equal(list.status, 200);
  const listHtml = await list.text();
  assert.match(listHtml, /dashboard-fixture/);
  assert(!listHtml.includes('<script>dangerous()</script>'));
  assert.match(listHtml, /Grouped issues/);
  const groupsResponse = await globalThis.fetch(collector + '/v1/issues', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(groupsResponse.status, 200);
  const groups = await groupsResponse.json();
  assert.equal(groups.items.length, 1);
  assert.equal(groups.items[0].occurrences, 1);
  const issueView = await get(`/issues/${groups.items[0].id}`, cookie);
  assert.equal(issueView.status, 200);
  assert.match(await issueView.text(), /Occurrences/);
  const detail = await get(`/incidents/${incident.id}`, cookie);
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /Execution timeline/);
  assert.match(detailHtml, /inventory-fixture/);
  for (const value of [token, password, secret]) {
    assert(!listHtml.includes(value));
    assert(!detailHtml.includes(value));
  }
  assert.equal((await get('/?service=missing', cookie)).status, 200);
  assert.equal((await get('/incidents/' + randomUUID(), cookie)).status, 404);
  assert.equal((await get('/', cookie + 'tampered')).status, 307);
  const logout = await globalThis.fetch(origin + '/auth/logout', {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, origin },
  });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/i);
  const stopped = once(collectorChild, 'exit');
  collectorChild.kill('SIGTERM');
  await stopped;
  const unavailable = await get('/', cookie);
  assert.equal(unavailable.status, 200);
  assert.match(await unavailable.text(), /Collector is unavailable/);
  console.log(
    'Dashboard smoke check passed: nonce CSP, sign-in, sessions, filters, incident detail, timeline, safe rendering, logout and collector outage.',
  );
} catch {
  console.error(
    'Dashboard smoke check failed. Inspect the dashboard and collector build/configuration.',
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
