import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

async function smoke() {
  const token = process.env.TIMEMACHINE_AUTH_TOKEN;
  if (!token) throw new Error('Set TIMEMACHINE_AUTH_TOKEN in .env or the environment.');
  const port = Number(process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT is invalid.');
  const base = `http://127.0.0.1:${port}`;
  const fixture = JSON.parse(
    readFileSync(
      new URL('../packages/core/test/fixtures/node-http-candidate.json', import.meta.url),
      'utf8',
    ),
  );
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  async function check(path, options, expected) {
    const response = await globalThis.fetch(base + path, {
      ...options,
      signal: globalThis.AbortSignal.timeout(5000),
    });
    if (!expected.includes(response.status))
      throw new Error(`Unexpected collector response: HTTP ${response.status}.`);
    return response;
  }
  await check('/health/live', {}, [200]);
  await check('/health/ready', {}, [200]);
  await check(
    '/v1/incidents',
    { method: 'POST', headers, body: JSON.stringify(fixture) },
    [201, 200],
  );
  const result = await check(`/v1/incidents/${fixture.id}`, { headers }, [200]);
  const body = await result.json();
  if (body.incident.id !== fixture.id || body.incident.schemaVersion !== 1)
    throw new Error('Unexpected incident contract.');
  const list = await check('/v1/incidents?limit=1', { headers }, [200]);
  const page = await list.json();
  if (
    page.apiVersion !== 1 ||
    !Array.isArray(page.items) ||
    page.items.length !== 1 ||
    !('nextCursor' in page)
  )
    throw new Error('Unexpected incident list contract.');
  await check('/v1/incidents', {}, [401]);
  await check(
    '/v1/incidents',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    [401],
  );
  await check(
    '/v1/incidents',
    { method: 'POST', headers, body: JSON.stringify({ ...fixture, schemaVersion: 2 }) },
    [422],
  );
  console.log(
    'Collector smoke check passed: health, ingestion, lookup, listing, authentication and schema rejection.',
  );
}

void smoke().catch((error) => {
  // Transport errors can contain URLs; print only the messages defined above.
  const message =
    error instanceof Error &&
    (error.message.startsWith('Set ') ||
      error.message.startsWith('PORT ') ||
      error.message.startsWith('Unexpected '))
      ? error.message
      : 'Could not complete the smoke check. Confirm the collector is running on loopback.';
  console.error(message);
  process.exitCode = 1;
});
