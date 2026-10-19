import { describe, expect, it } from 'vitest';
import { createTimeMachine } from '../src/index.js';
import { client, options, token } from './helpers.js';

describe('SDK configuration', () => {
  it.each([
    'http://127.0.0.1:4318',
    'http://localhost:4318',
    'http://[::1]:4318',
    'https://collector.example.test/base',
  ])('accepts supported endpoint %s', (collectorUrl) => {
    expect(() => client({ collectorUrl })).not.toThrow();
  });

  it.each([
    'http://collector.example.test',
    'ftp://collector.example.test',
    'https://user:password@collector.example.test',
    'https://collector.example.test?token=value',
    'https://collector.example.test#fragment',
    'invalid',
  ])('rejects unsafe endpoint %s without exposing it', (collectorUrl) => {
    expect(() => createTimeMachine({ ...options, collectorUrl })).toThrow(
      /Invalid TimeMachine/,
    );
  });

  it('supports explicit insecure HTTP opt-in for a trusted development network', () => {
    expect(() =>
      client({ collectorUrl: 'http://collector.example.test', allowInsecureHttp: true }),
    ).not.toThrow();
  });

  it.each([
    { token: 'short' },
    { token: ' '.repeat(32) },
    { maxQueueSize: 0 },
    { maxQueueBytes: 0 },
    { requestTimeoutMs: 0 },
    { maxRetries: 4 },
    { retryDelayMs: -1 },
  ])('rejects invalid delivery settings %j', (overrides) => {
    expect(() => createTimeMachine({ ...options, ...overrides })).toThrow(
      'Invalid TimeMachine SDK configuration',
    );
  });

  it('rejects collector credentials in service metadata', () => {
    expect(() =>
      createTimeMachine({ ...options, service: { ...options.service, version: token } }),
    ).toThrow('Collector credentials cannot be used as service metadata');
  });
});
