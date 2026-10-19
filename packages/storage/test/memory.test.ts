import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/memory.js';
import { fixture } from './fixtures.js';

const limits = { maxEntries: 2, maxBytes: 1024 * 1024, retentionMs: 1000 };
const nextId = '284977b1-c89a-4d1b-8b74-247c59d08743';

describe('bounded in-memory storage', () => {
  it('returns isolated copies and does not retain caller references', async () => {
    const store = createMemoryStore(limits);
    const incident = fixture();
    await store.save(incident);
    incident.service.name = 'changed';
    const first = await store.get(incident.id);
    expect(first!.service.name).toBe('example-orders');
    first!.service.name = 'changed-again';
    expect((await store.get(incident.id))!.service.name).toBe('example-orders');
  });

  it('accounts for aggregate UTF-8 bytes and accepts exact capacity', async () => {
    const incident = fixture();
    incident.failure.summary = '🙂';
    const bytes = Buffer.byteLength(JSON.stringify(incident)) + 512; // Reserved issue lifecycle metadata.
    const store = createMemoryStore({ ...limits, maxBytes: bytes });
    expect(await store.save(incident)).toBe('created');
    expect(await store.save(incident)).toBe('duplicate');
    expect(await store.isReady()).toBe(false);
    await expect(store.save({ ...incident, id: nextId })).rejects.toMatchObject({
      code: 'STORE_CAPACITY_EXCEEDED',
    });
    expect((await store.get(incident.id))!.failure.summary).toBe('🙂');
  });

  it('expires records and releases capacity without a background timer', async () => {
    let now = 0;
    const store = createMemoryStore({ ...limits, maxEntries: 1, now: () => now });
    const incident = fixture();
    await store.save(incident);
    now = 999;
    expect(await store.get(incident.id)).toBeDefined();
    now = 1000;
    expect(await store.get(incident.id)).toBeUndefined();
    expect(await store.isReady()).toBe(true);
    expect(await store.save({ ...incident, id: nextId })).toBe('created');
  });

  it('does not extend retention on duplicate retries', async () => {
    let now = 0;
    const store = createMemoryStore({ ...limits, now: () => now });
    const incident = fixture();
    await store.save(incident);
    now = 999;
    expect(await store.save(incident)).toBe('duplicate');
    now = 1000;
    expect(await store.get(incident.id)).toBeUndefined();
  });

  it('rejects writes and reads after close and reports unavailable', async () => {
    const store = createMemoryStore(limits);
    await store.close();
    expect(await store.isReady()).toBe(false);
    await expect(store.save(fixture())).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
    });
    await expect(store.get(fixture().id)).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
    });
    await store.close();
  });

  it.each([0, -1, 1.5, Infinity])('rejects invalid storage limits %s', (maxEntries) => {
    expect(() => createMemoryStore({ ...limits, maxEntries })).toThrow(
      'Invalid memory store limits',
    );
  });
});

it('list hides expired records and rejects reads after close', async () => {
  let now = 0;
  const store = createMemoryStore({ ...limits, now: () => now });
  await store.save(fixture());
  expect((await store.list({ limit: 1 })).items).toHaveLength(1);
  now = 1000;
  expect(await store.list({ limit: 1 })).toEqual({ items: [], nextCursor: null });
  await store.close();
  await expect(store.list({ limit: 1 })).rejects.toMatchObject({
    code: 'STORE_UNAVAILABLE',
  });
});
