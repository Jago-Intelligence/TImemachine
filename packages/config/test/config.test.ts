import { describe, expect, it } from 'vitest';
import { parseServerConfig } from '../src/index.js';

describe('server configuration', () => {
  it('uses a loopback binding and safe defaults', () => {
    expect(parseServerConfig({})).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 4318,
      LOG_LEVEL: 'info',
    });
    expect(Object.isFrozen(parseServerConfig({}))).toBe(true);
  });

  it.each(['0', '65536', '1.5', '', 'invalid'])('rejects invalid port %s', (PORT) => {
    expect(() => parseServerConfig({ PORT })).toThrow('PORT');
  });

  it('requires credentials for externally reachable bindings', () => {
    expect(() => parseServerConfig({ HOST: '0.0.0.0' })).toThrow(
      'TIMEMACHINE_AUTH_TOKEN',
    );
    expect(
      parseServerConfig({ HOST: '0.0.0.0', TIMEMACHINE_AUTH_TOKEN: 'x'.repeat(32) }).HOST,
    ).toBe('0.0.0.0');
  });

  it('rejects whitespace credentials for external bindings', () => {
    expect(() =>
      parseServerConfig({ HOST: '0.0.0.0', TIMEMACHINE_AUTH_TOKEN: ' '.repeat(32) }),
    ).toThrow('TIMEMACHINE_AUTH_TOKEN');
  });

  it('accepts PostgreSQL URLs and rejects other protocols', () => {
    expect(
      parseServerConfig({ DATABASE_URL: 'postgresql://user:secret@localhost/db' })
        .DATABASE_URL,
    ).toBe('postgresql://user:secret@localhost/db');
    expect(() => parseServerConfig({ DATABASE_URL: 'https://localhost/db' })).toThrow(
      'DATABASE_URL',
    );
  });

  it('does not include supplied secrets in validation errors', () => {
    expect(() => parseServerConfig({ TIMEMACHINE_AUTH_TOKEN: 'private-token' })).toThrow(
      'Invalid server configuration: TIMEMACHINE_AUTH_TOKEN',
    );
  });

  it('rejects invalid modes and levels while ignoring unrelated environment keys', () => {
    expect(() => parseServerConfig({ NODE_ENV: 'staging' })).toThrow('NODE_ENV');
    expect(() => parseServerConfig({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
    expect(parseServerConfig({ UNRELATED: 'value' })).not.toHaveProperty('UNRELATED');
  });
});

it.each([
  ['RATE_LIMIT_MAX', '0'],
  ['RATE_LIMIT_WINDOW_MS', '10'],
  ['INCIDENT_STORE_MAX_ENTRIES', '-1'],
  ['INCIDENT_STORE_MAX_BYTES', '0'],
  ['INCIDENT_RETENTION_MS', 'NaN'],
  ['SHUTDOWN_TIMEOUT_MS', '0'],
  ['TIMEMACHINE_AUTH_TOKEN', 'x'.repeat(257)],
])('rejects invalid collector setting %s', (field, value) => {
  expect(() => parseServerConfig({ [field]: value })).toThrow(field);
});

it('requires a database URL for PostgreSQL and durable storage in production', () => {
  expect(() => parseServerConfig({ STORAGE_DRIVER: 'postgres' })).toThrow('DATABASE_URL');
  expect(() => parseServerConfig({ NODE_ENV: 'production' })).toThrow('STORAGE_DRIVER');
  expect(
    parseServerConfig({
      NODE_ENV: 'production',
      STORAGE_DRIVER: 'postgres',
      DATABASE_URL: 'postgresql://user:password@localhost/db',
    }).STORAGE_DRIVER,
  ).toBe('postgres');
});

it('keeps custom app replay registration restricted to local development', () => {
  expect(() =>
    parseServerConfig({
      HOST: '0.0.0.0',
      TIMEMACHINE_AUTH_TOKEN: 'synthetic-test-token-12345678901234567890',
      REPLAY_APPS_FILE: '/tmp/replay-apps.json',
    }),
  ).toThrow('REPLAY_APPS_FILE');
  expect(() =>
    parseServerConfig({
      NODE_ENV: 'production',
      REPLAY_APPS_FILE: '/tmp/replay-apps.json',
    }),
  ).toThrow('REPLAY_APPS_FILE');
});
