import { afterEach, beforeEach, vi } from 'vitest';
import { parseIncidentJson } from '@timemachine/core';
import {
  createTimeMachine,
  type TimeMachineClient,
  type TimeMachineOptions,
} from '../src/index.js';

export const token = 'synthetic-sdk-test-token-1234567890';
export const options: TimeMachineOptions = {
  collectorUrl: 'http://127.0.0.1:4318',
  token,
  service: { name: 'test-app', version: '0.1.0', environment: 'test' },
  maxRetries: 0,
  requestTimeoutMs: 50,
  retryDelayMs: 1,
};
export const clients: TimeMachineClient[] = [];
export const requests: { url: string; options: RequestInit; body: string }[] = [];
export const mockFetch = vi.fn<typeof fetch>();

export function acknowledge(init?: RequestInit, status = 201): Response {
  const payload: unknown = JSON.parse(String(init?.body));
  const body = parseIncidentJson(
    JSON.stringify(
      typeof payload === 'object' &&
        payload !== null &&
        'captureVersion' in payload &&
        'incident' in payload
        ? payload.incident
        : payload,
    ),
  );
  return new Response(
    JSON.stringify({
      apiVersion: 1,
      incidentId: body.id,
      status: status === 201 ? 'accepted' : 'duplicate',
    }),
    { status },
  );
}

export function client(overrides: Partial<TimeMachineOptions> = {}) {
  const sdk = createTimeMachine({ ...options, ...overrides });
  clients.push(sdk);
  return sdk;
}

export function blockDelivery() {
  mockFetch.mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error('Aborted'));
        else
          init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          });
      }),
  );
}

beforeEach(() => {
  requests.length = 0;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url, init) => {
    requests.push({ url: String(url), options: init ?? {}, body: String(init?.body) });
    return acknowledge(init);
  });
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((sdk) => sdk.close({ timeoutMs: 20 })));
  vi.unstubAllGlobals();
});
