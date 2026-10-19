import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { publicAlertFetch } from '../src/alert-transport.js';
afterEach(() => vi.resetAllMocks());
function connection(status = 200) {
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  const response = { statusCode: status, destroy: vi.fn() };
  const outgoing = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn(),
  });
  mocks.request.mockImplementation((_options, receive) => {
    outgoing.end.mockImplementation(() => receive(response));
    return outgoing;
  });
  return { outgoing, response };
}
test('connects only to the checked IP while retaining the original TLS identity and Host', async () => {
  const { response } = connection();
  expect(
    (
      await publicAlertFetch('https://hooks.example.test/secret/path?q=x', {
        method: 'POST',
        body: '{}',
      })
    ).ok,
  ).toBe(true);
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  expect(mocks.request.mock.calls[0]![0]).toMatchObject({
    hostname: '8.8.8.8',
    servername: 'hooks.example.test',
    rejectUnauthorized: true,
    path: '/secret/path?q=x',
    agent: false,
    headers: { host: 'hooks.example.test' },
  });
  expect(response.destroy).toHaveBeenCalled();
});
test.each([301, 302, 307, 308, 600])(
  'rejects redirect/invalid status %i without following it',
  async (status) => {
    connection(status);
    await expect(
      publicAlertFetch('https://hooks.example.test/', { method: 'POST', body: '{}' }),
    ).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  },
);
test('private or rebound DNS answers never open a connection', async () => {
  mocks.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
  await expect(
    publicAlertFetch('https://hooks.example.test/', { method: 'POST', body: '{}' }),
  ).rejects.toThrow('Unsafe');
  expect(mocks.request).not.toHaveBeenCalled();
});
test('an already aborted delivery never connects', async () => {
  connection();
  await expect(
    publicAlertFetch('https://hooks.example.test/', {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
});
