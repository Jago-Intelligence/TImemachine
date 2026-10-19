import { expect, it } from 'vitest';
import { createRecordedHttpFetch } from '../src/recorded-http.js';
import type { HttpRecording } from '@timemachine/core';
const recording: HttpRecording = {
  version: 1,
  policyId: 'safe-v1',
  request: { method: 'POST', route: '/checkout', body: { quantity: 2 }, partial: false },
  dependencies: [
    {
      id: 'pricing',
      origin: 'http://127.0.0.1:4330',
      method: 'GET',
      route: '/price',
      statusCode: 200,
      body: { unitCents: 1500 },
      partial: false,
      result: 'response',
    },
  ],
  truncated: false,
};
it('serves captured responses without network access and detects unused calls', async () => {
  const replay = createRecordedHttpFetch(recording);
  expect(() => replay.assertComplete()).toThrow();
  expect(await (await replay.fetch('http://127.0.0.1:4330/price')).json()).toEqual({
    unitCents: 1500,
  });
  replay.assertComplete();
  await expect(replay.fetch('http://127.0.0.1:4330/price')).rejects.toThrow();
  expect(() => replay.assertComplete()).toThrow();
});
it('rejects wrong origins, queries and request bodies even if the app catches the error', async () => {
  for (const [url, init] of [
    ['https://untrusted.example/price', undefined],
    ['http://127.0.0.1:4330/price?private=1', undefined],
    ['http://127.0.0.1:4330/price', { body: 'private', method: 'POST' }],
  ] as const) {
    const replay = createRecordedHttpFetch(recording);
    await expect(replay.fetch(url, init)).rejects.toThrow();
    expect(() => replay.assertComplete()).toThrow();
  }
});
