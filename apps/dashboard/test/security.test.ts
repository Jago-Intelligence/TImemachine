import { expect, test } from 'vitest';
import {
  createSession,
  validSession,
  passwordMatches,
  SESSION_SECONDS,
  allowLogin,
} from '../src/lib/session';
import { dashboardConfig } from '../src/lib/config';
import { readLoginForm } from '../src/lib/http';
const secret = 'synthetic-dashboard-session-secret-123456789';
const config = {
  DASHBOARD_PASSWORD: 'synthetic-password',
  DASHBOARD_SESSION_SECRET: secret,
  TIMEMACHINE_AUTH_TOKEN: 'synthetic-collector-token-123456789',
};
test('accepts signed sessions only until their expiry', () => {
  const token = createSession(secret, 100000);
  expect(validSession(token, secret, 100000)).toBe(true);
  expect(validSession(token, secret, 100000 + SESSION_SECONDS * 1000)).toBe(false);
  expect(validSession(token, 'another-secret', 100000)).toBe(false);
  expect(validSession(token + '.extra', secret, 100000)).toBe(false);
  expect(validSession(undefined, secret)).toBe(false);
  expect(validSession(token, secret, 0)).toBe(false);
});
test('password comparisons reject wrong and oversized input', () => {
  expect(passwordMatches('synthetic-password', 'synthetic-password')).toBe(true);
  expect(passwordMatches('bad', 'synthetic-password')).toBe(false);
  expect(passwordMatches('x'.repeat(257), 'synthetic-password')).toBe(false);
});
test('login attempts have a bounded per-process budget', () => {
  const now = Date.now();
  for (let i = 0; i < 20; i++) expect(allowLogin(now)).toBe(true);
  expect(allowLogin(now)).toBe(false);
  expect(allowLogin(now + 60000)).toBe(true);
});
test('configuration defaults to local connections and rejects unsafe URL settings', () => {
  expect(dashboardConfig(config).collector).toBe('http://127.0.0.1:4318');
  expect(dashboardConfig(config).secureCookie).toBe(false);
  for (const url of [
    'http://remote.example',
    'https://user:secret@remote.example',
    'https://remote.example/?token=secret',
    'ftp://remote.example',
  ])
    expect(() => dashboardConfig({ ...config, TIMEMACHINE_COLLECTOR_URL: url })).toThrow(
      'Invalid dashboard URL',
    );
  expect(
    dashboardConfig({ ...config, DASHBOARD_ORIGIN: 'https://dashboard.example' })
      .secureCookie,
  ).toBe(true);
  expect(() => dashboardConfig({ ...config, DASHBOARD_PASSWORD: 'short' })).toThrow(
    'configuration is incomplete',
  );
});
test('bounds login bodies even without a content-length header', async () => {
  const form = (body: string) =>
    new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  expect((await readLoginForm(form('password=synthetic')))!.get('password')).toBe(
    'synthetic',
  );
  expect(await readLoginForm(form('password=' + 'x'.repeat(5000)))).toBeUndefined();
  expect(
    await readLoginForm(new Request('http://localhost', { method: 'POST', body: '{}' })),
  ).toBeUndefined();
});

test('collector default is independent of Next.js listening PORT', () => {
  expect(dashboardConfig({ ...config, PORT: '4321' }).collector).toBe(
    'http://127.0.0.1:4318',
  );
});
