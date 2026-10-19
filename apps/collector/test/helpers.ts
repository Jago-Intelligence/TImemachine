import { readFileSync } from 'node:fs';
import { parseServerConfig } from '@timemachine/config';
import { parseIncidentJson } from '@timemachine/core';
import { createLogger } from '@timemachine/logger';
import { createMemoryStore } from '@timemachine/storage';
import { createCollector } from '../src/server.js';
import type { IncidentStore } from '@timemachine/storage';

export const token = 'synthetic-test-collector-token-123456789';
export const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};

export function fixture() {
  return parseIncidentJson(
    readFileSync(
      new URL(
        '../../../packages/core/test/fixtures/node-http-candidate.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
}

export function memoryStore() {
  return createMemoryStore({ maxEntries: 10, maxBytes: 1024 * 1024, retentionMs: 60000 });
}

export async function testCollector(
  env: Record<string, string> = {},
  store: IncidentStore = memoryStore(),
) {
  const logs: string[] = [];
  const config = parseServerConfig({
    NODE_ENV: 'test',
    TIMEMACHINE_AUTH_TOKEN: token,
    ...env,
  });
  const logger = createLogger(
    { service: 'collector', level: 'info' },
    {
      write: (line: string) => {
        logs.push(line);
      },
    },
  );
  const collector = await createCollector({ config, store, logger });
  return { ...collector, logs, store };
}
