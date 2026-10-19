import { describe, expect, it } from 'vitest';
import { fixture, headers, testCollector } from './helpers.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('graceful shutdown', () => {
  it('drains an active HTTP ingestion before closing the store', async () => {
    const collector = await testCollector();
    const blocked = gate();
    const entered = gate();
    let closed = false;
    const originalSave = collector.store.save;
    const originalClose = collector.store.close;
    collector.store.save = async (incident) => {
      entered.release();
      await blocked.promise;
      expect(closed).toBe(false);
      return originalSave(incident);
    };
    collector.store.close = async () => {
      closed = true;
      await originalClose();
    };
    const address = await collector.app.listen({ host: '127.0.0.1', port: 0 });
    const response = fetch(`${address}/v1/incidents`, {
      method: 'POST',
      headers,
      body: JSON.stringify(fixture()),
    });
    try {
      await entered.promise;
      const closing = collector.shutdown();
      expect(collector.shutdown()).toBe(closing);
      expect(closed).toBe(false);
      blocked.release();
      expect((await response).status).toBe(201);
      await closing;
      expect(closed).toBe(true);
    } finally {
      blocked.release();
      await collector.app.close();
    }
  });

  it('marks readiness unavailable and rejects new work as draining begins', async () => {
    const collector = await testCollector();
    const paused = gate();
    const entered = gate();
    collector.app.addHook('preClose', async () => {
      entered.release();
      await paused.promise;
    });
    const address = await collector.app.listen({ host: '127.0.0.1', port: 0 });
    const closing = collector.shutdown();
    try {
      await entered.promise;
      expect((await fetch(`${address}/health/ready`)).status).toBe(503);
      expect((await fetch(`${address}/health/live`)).status).toBe(200);
      const rejected = await fetch(`${address}/v1/incidents`, {
        method: 'POST',
        headers,
        body: JSON.stringify(fixture()),
      });
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toMatchObject({ error: { code: 'SHUTTING_DOWN' } });
    } finally {
      paused.release();
      await closing;
    }
  });

  it('enforces the shutdown deadline even if resource cleanup stalls', async () => {
    const collector = await testCollector({ SHUTDOWN_TIMEOUT_MS: '100' });
    const paused = gate();
    collector.store.close = async () => {
      await paused.promise;
    };
    try {
      await expect(collector.shutdown()).rejects.toThrow(
        'Collector shutdown deadline exceeded',
      );
    } finally {
      paused.release();
      await collector.app.close();
    }
  });
});
