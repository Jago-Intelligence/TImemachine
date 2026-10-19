import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  denied.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  denied.addSubnet(address, prefix, 'ipv6');

export function publicAlertAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  return (
    family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6')
  );
}

export async function resolveAlertDestination(input: string | URL, resolve = lookup) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Unsafe alert destination');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answers = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([
        resolve(hostname, { all: true, verbatim: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Alert DNS deadline exceeded')),
            5000,
          );
          timer.unref();
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
  // Reject mixed public/private answers, including IPv4-mapped IPv6 addresses.
  if (!answers.length || answers.some((row) => !publicAlertAddress(row.address)))
    throw new Error('Unsafe alert destination');
  return { url, address: answers[0]!.address, hostname };
}

/** Production alert POSTs pin the checked address; DNS is not repeated at connect. */
export const publicAlertFetch: typeof fetch = async (input, init) => {
  const target = typeof input === 'string' || input instanceof URL ? input : input.url;
  const destination = await resolveAlertDestination(target);
  init?.signal?.throwIfAborted();
  if (init?.method !== 'POST' || typeof init.body !== 'string')
    throw new Error('Unsupported alert request');
  const headers = new Headers(init.headers);
  headers.set('host', destination.url.host);
  headers.set('content-length', String(Buffer.byteLength(init.body)));
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      {
        protocol: 'https:',
        hostname: destination.address,
        servername: isIP(destination.hostname) ? undefined : destination.hostname,
        port: destination.url.port || 443,
        path: destination.url.pathname + destination.url.search,
        method: 'POST',
        headers: Object.fromEntries(headers),
        signal: init.signal ?? undefined,
        rejectUnauthorized: true,
        agent: false,
        timeout: 5000,
        maxHeaderSize: 16384,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        // Delivery only needs the status. Never buffer an untrusted response body.
        incoming.destroy();
        if (status < 200 || status > 599) reject(new Error('Invalid alert response'));
        else if (status >= 300 && status < 400)
          reject(new Error('Alert redirect rejected'));
        else resolve(new Response(null, { status }));
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error('Alert deadline exceeded')));
    outgoing.on('error', reject);
    outgoing.end(init.body);
  });
};
