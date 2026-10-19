import { expect, test, vi } from 'vitest';
import {
  publicAlertAddress,
  resolveAlertDestination,
  publicAlertFetch,
} from '../src/alert-transport.js';
import { lookup } from 'node:dns/promises';

test.each([
  '127.0.0.1',
  '0.0.0.0',
  '10.1.1.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.100.100.200',
  '224.0.0.1',
  '::1',
  '::',
  '::ffff:127.0.0.1',
  '::ffff:8.8.8.8',
  'fc00::1',
  'fe80::1',
  '2001:db8::1',
  '2002:7f00:1::',
  'not-an-ip',
])('blocks non-public destination %s', (address) => {
  expect(publicAlertAddress(address)).toBe(false);
});
test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
  'accepts public address %s',
  (address) => {
    expect(publicAlertAddress(address)).toBe(true);
  },
);
test('rejects mixed DNS results and pins a checked address without a second lookup', async () => {
  const dns = vi.fn().mockResolvedValue([
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ]);
  await expect(
    resolveAlertDestination('https://webhook.example/path', dns as typeof lookup),
  ).rejects.toThrow('Unsafe');
  dns.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  const result = await resolveAlertDestination(
    'https://webhook.example/path',
    dns as typeof lookup,
  );
  expect(result.address).toBe('8.8.8.8');
  expect(result.hostname).toBe('webhook.example');
  expect(dns).toHaveBeenCalledTimes(2);
});
test.each([
  'https://127.0.0.1/',
  'https://[::ffff:127.0.0.1]/',
  'http://public.example/',
  'https://user:secret@public.example/',
])('rejects unsafe URL before sending %s', async (url) => {
  await expect(publicAlertFetch(url, { method: 'POST', body: '{}' })).rejects.toThrow(
    'Unsafe',
  );
});

test('a stalled DNS lookup has a deadline and cannot open a connection', async () => {
  vi.useFakeTimers();
  try {
    const dns = vi.fn().mockReturnValue(new Promise(() => {}));
    const check = expect(
      resolveAlertDestination('https://hooks.example.test/', dns as typeof lookup),
    ).rejects.toThrow('DNS deadline');
    await vi.advanceTimersByTimeAsync(5000);
    await check;
  } finally {
    vi.useRealTimers();
  }
});
