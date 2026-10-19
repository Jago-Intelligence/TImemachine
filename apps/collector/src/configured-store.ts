import { readFileSync } from 'node:fs';
import type { ServerConfig } from '@timemachine/config';
import {
  createMemoryStore,
  createPostgresStore,
  type IncidentStore,
} from '@timemachine/storage';

export function createConfiguredStore(config: ServerConfig): IncidentStore {
  if (config.STORAGE_DRIVER === 'memory') {
    return createMemoryStore({
      maxEntries: config.INCIDENT_STORE_MAX_ENTRIES,
      maxBytes: config.INCIDENT_STORE_MAX_BYTES,
      retentionMs: config.INCIDENT_RETENTION_MS,
    });
  }
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return createPostgresStore({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL,
    maxConnections: config.DATABASE_POOL_MAX,
    timeoutMs: config.DATABASE_TIMEOUT_MS,
    retentionDays: config.DATABASE_RETENTION_DAYS,
    ...(config.DATABASE_CA_FILE
      ? { ca: readFileSync(config.DATABASE_CA_FILE, 'utf8') }
      : {}),
  });
}
