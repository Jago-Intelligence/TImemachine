import { expect, it, vi } from 'vitest';
import { createFetchRecording, createFetchReplay } from '../src/fetch-fixtures.js';

it('projects reviewed data without consuming the application response', async () => {
  const recording = createFetchRecording({
    fetch: vi.fn(async () =>
      Response.json({ available: false, token: 'secret' }),
    ) as typeof fetch,
    project: async (response) => ({
      status: response.status,
      body: JSON.stringify({
        available: ((await response.json()) as { available: boolean }).available,
      }),
    }),
  });
  const response = await recording.fetch('https://private.example/customer?token=secret');
  expect(await response.json()).toHaveProperty('token', 'secret');
  expect(JSON.stringify(recording.snapshot())).not.toContain('secret');
  const replay = createFetchReplay(recording.snapshot());
  expect(await (await replay.fetch('https://unused.example')).json()).toEqual({
    available: false,
  });
  replay.assertComplete();
  await expect(replay.fetch('https://unused.example')).rejects.toThrow('Unexpected');
});
it('rejects incomplete recordings and unused fixtures', async () => {
  const recording = createFetchRecording({
    fetch: vi.fn(async () => {
      throw new Error('private');
    }) as typeof fetch,
    project: async () => ({ status: 200, body: '' }),
  });
  await expect(recording.fetch('https://unused.example')).rejects.toThrow();
  expect(() => recording.snapshot()).toThrow('Incomplete');
  expect(() =>
    createFetchReplay([{ status: 200, body: '{}' }]).assertComplete(),
  ).toThrow();
});

it('preserves successful application fetches when projection fails', async () => {
  const recording = createFetchRecording({
    fetch: vi.fn(async () => new Response('original')) as typeof fetch,
    project: async () => {
      throw new Error('Cannot sanitize');
    },
  });
  expect(await (await recording.fetch('https://unused.example')).text()).toBe('original');
  expect(() => recording.snapshot()).toThrow('Incomplete');
});
