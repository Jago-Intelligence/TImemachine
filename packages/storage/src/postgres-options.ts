import { z } from 'zod';
import type { PoolConfig } from 'pg';

const optionsSchema = z.strictObject({
  connectionString: z.url(),
  ssl: z.enum(['require', 'disable']).default('require'),
  ca: z.string().min(1).max(1048576).optional(),
  maxConnections: z.number().int().min(1).max(50).default(10),
  timeoutMs: z.number().int().min(100).max(30000).default(5000),
  retentionDays: z.number().int().min(1).max(3650).default(30),
});

export type PostgresOptions = z.input<typeof optionsSchema>;

export function parsePostgresOptions(input: PostgresOptions) {
  const result = optionsSchema.safeParse(input);
  if (!result.success) throw new Error('Invalid PostgreSQL configuration');
  const config = result.data;
  const url = new URL(config.connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search !== '') {
    throw new Error(
      'Invalid PostgreSQL connection URL; configure connection options separately',
    );
  }
  const pool: PoolConfig = {
    connectionString: config.connectionString,
    ssl:
      config.ssl === 'require'
        ? { rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) }
        : false,
    max: config.maxConnections,
    connectionTimeoutMillis: config.timeoutMs,
    statement_timeout: config.timeoutMs,
    lock_timeout: config.timeoutMs,
    query_timeout: config.timeoutMs + 1000,
    idle_in_transaction_session_timeout: config.timeoutMs,
    idleTimeoutMillis: 10000,
    application_name: 'timemachine',
  };
  return { config, pool };
}
