import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { installAxiosRecording } from '../src/axios-adapter.js';
it('uses the real Axios transform pipeline while recording JSON and restoring its transport', async () => {
  const transport = vi.fn(async (config) => ({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    data: '{"rate":2}',
    config,
  }));
  const client = axios.create({ adapter: transport });
  const calls: { url: string; body: unknown }[] = [];
  const restore = installAxiosRecording(
    client,
    (implementation) => async (url, init) => {
      const response = await implementation(url, init);
      calls.push({ url: String(url), body: await response.clone().json() });
      return response;
    },
    axios.getAdapter,
  );
  expect((await client.get('https://pricing.example/rates')).data).toEqual({ rate: 2 });
  expect(calls).toEqual([{ url: 'https://pricing.example/rates', body: { rate: 2 } }]);
  restore();
  expect(client.defaults.adapter).toBe(transport);
});
it('records HTTP error responses without replacing the original Axios error', async () => {
  const original = Object.assign(new Error('private upstream details'), {
    response: {
      status: 500,
      data: '{"code":"UNAVAILABLE"}',
      headers: { 'content-type': 'application/json' },
    },
  });
  const client = {
    defaults: {
      adapter: async (config: unknown) => {
        void config;
        throw original;
      },
    },
    getAdapter: (value: unknown) => value,
  };
  let code = 0;
  installAxiosRecording(client, (implementation) => async (url, init) => {
    const response = await implementation(url, init);
    code = response.status;
    return response;
  });
  await expect(
    client.defaults.adapter({ url: 'https://pricing.example/rates' }),
  ).rejects.toBe(original);
  expect(code).toBe(500);
});
