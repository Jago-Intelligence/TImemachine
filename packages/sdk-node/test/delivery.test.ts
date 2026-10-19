import { describe, expect, it } from 'vitest';
import { acknowledge, blockDelivery, client, mockFetch } from './helpers.js';

describe('bounded delivery', () => {
  it.each([200, 201])(
    'accepts the collector acknowledgement with status %s',
    async (status) => {
      mockFetch.mockImplementation(async (_url, init) => acknowledge(init, status));
      const sdk = client();
      sdk.captureException(new Error('synthetic'));
      expect(await sdk.flush()).toBe(true);
      expect(sdk.getStats().delivered).toBe(1);
    },
  );

  it('retries transient failure with the same incident ID and body', async () => {
    const bodies: string[] = [];
    mockFetch.mockImplementation(async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1 ? new Response('', { status: 503 }) : acknowledge(init);
    });
    const sdk = client({ maxRetries: 2 });
    sdk.captureException(new Error('synthetic'));
    expect(await sdk.flush()).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(sdk.getStats()).toMatchObject({ delivered: 1, failed: 0 });
  });

  it.each([400, 401, 409, 413, 415, 422])(
    'does not retry permanent rejection %s',
    async (status) => {
      mockFetch.mockResolvedValue(new Response('', { status }));
      const sdk = client({ maxRetries: 3 });
      sdk.captureException(new Error('synthetic'));
      expect(await sdk.flush()).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sdk.getStats()).toMatchObject({ failed: 1, delivered: 0 });
    },
  );

  it('bounds network retries and suppresses raw transport errors', async () => {
    mockFetch.mockRejectedValue(new Error('private-transport-credential'));
    const sdk = client({ maxRetries: 2 });
    expect(sdk.captureException(new Error('synthetic')).queued).toBe(true);
    expect(await sdk.flush()).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(sdk.getStats()).toMatchObject({ failed: 1, pending: 0 });
  });

  it.each(['{}', 'not-json', 'x'.repeat(4097)])(
    'rejects invalid or oversized acknowledgements',
    async (body) => {
      mockFetch.mockImplementation(async () => new Response(body, { status: 201 }));
      const sdk = client({ maxRetries: 3 });
      sdk.captureException(new Error('synthetic'));
      await sdk.flush();
      expect(sdk.getStats()).toMatchObject({ failed: 1, delivered: 0 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('counts in-flight work against queue entry and byte bounds', async () => {
    blockDelivery();
    const sdk = client({ maxQueueSize: 1, requestTimeoutMs: 1000 });
    expect(sdk.captureException('synthetic').queued).toBe(true);
    expect(sdk.captureException('synthetic')).toEqual({
      queued: false,
      reason: 'queue-full',
    });
    expect(sdk.getStats()).toMatchObject({ pending: 1, dropped: 1 });
    const byteBound = client({
      maxQueueSize: 10,
      maxQueueBytes: 1024,
      requestTimeoutMs: 1000,
    });
    expect(byteBound.captureException('synthetic').queued).toBe(true);
    expect(byteBound.captureException('synthetic')).toEqual({
      queued: false,
      reason: 'queue-full',
    });
  });

  it('times out a request without waiting indefinitely for the collector', async () => {
    blockDelivery();
    const sdk = client({ requestTimeoutMs: 10 });
    sdk.captureException('synthetic');
    expect(await sdk.flush({ timeoutMs: 500 })).toBe(true);
    expect(sdk.getStats()).toMatchObject({ failed: 1, pending: 0 });
  });

  it('flush timeout leaves work pending; close timeout aborts and drops it', async () => {
    blockDelivery();
    const sdk = client({ requestTimeoutMs: 1000 });
    sdk.captureException('synthetic');
    expect(await sdk.flush({ timeoutMs: 10 })).toBe(false);
    expect(sdk.getStats().pending).toBe(1);
    const closing = sdk.close({ timeoutMs: 10 });
    expect(await closing).toBe(false);
    expect(await sdk.close()).toBe(false);
    expect(sdk.getStats()).toMatchObject({ pending: 0, pendingBytes: 0, dropped: 1 });
    expect(sdk.captureException('synthetic')).toEqual({
      queued: false,
      reason: 'closed',
    });
  });

  it('abort interrupts Retry-After sleep on shutdown', async () => {
    mockFetch.mockResolvedValue(
      new Response('', { status: 429, headers: { 'retry-after': '999999' } }),
    );
    const sdk = client({ maxRetries: 3 });
    sdk.captureException('synthetic');
    expect(await sdk.close({ timeoutMs: 20 })).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sdk.getStats().pending).toBe(0);
  });

  it('closes after draining and exposes immutable statistics', async () => {
    const sdk = client();
    sdk.captureException('synthetic');
    expect(await sdk.close()).toBe(true);
    expect(sdk.getStats()).toMatchObject({ delivered: 1, failed: 0, pending: 0 });
    expect(Object.isFrozen(sdk.getStats())).toBe(true);
    expect(sdk.captureException('synthetic').queued).toBe(false);
  });

  it.each([0, -1, 1.5, 60001])('rejects invalid flush timeout %s', (timeoutMs) => {
    expect(() => client().flush({ timeoutMs })).toThrow('Invalid SDK flush timeout');
  });
});
