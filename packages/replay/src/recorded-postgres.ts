import { createHash } from 'node:crypto';
import {
  normalizePostgresQuery,
  postgresRecordingSchema,
  type PostgresRecording,
} from '@timemachine/core';

export interface RecordedPostgres {
  query(
    input: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
    command: 'SELECT';
    fields: Array<{ name: string }>;
  }>;
  assertComplete(): void;
}
export function createRecordedPostgres(
  input: readonly PostgresRecording[],
): RecordedPostgres {
  if (input.length > 10) throw new Error('Too many database fixtures');
  const records = input.map((row) => postgresRecordingSchema.parse(row));
  let next = 0,
    invalid = false;
  return {
    async query(input, values) {
      try {
        if (
          typeof input !== 'string' &&
          Object.keys(input).some((key) => !['text', 'values'].includes(key))
        )
          throw new Error('Unsupported query configuration');
        const text = normalizePostgresQuery(
          typeof input === 'string' ? input : input.text,
        );
        const parameters =
          values ?? (typeof input === 'string' ? [] : (input.values ?? []));
        const row = records[next];
        if (
          !text ||
          !row ||
          row.partial ||
          row.result === 'omitted' ||
          row.queryHash !== createHash('sha256').update(text).digest('hex') ||
          JSON.stringify(parameters) !== JSON.stringify(row.parameters)
        )
          throw new Error('Unexpected database query');
        next++;
        if (row.result === 'error') {
          if (!row.errorCode) throw new Error('Incomplete database error');
          const error = new Error('Recorded database dependency failed') as Error & {
            code: string;
          };
          error.code = row.errorCode;
          // A matched database error is expected behavior, not a mock mismatch.
          return Promise.reject(error);
        }
        return {
          rows: structuredClone(row.rows),
          rowCount: row.rowCount,
          command: 'SELECT',
          fields: (row.fields ?? Object.keys(row.rows[0] ?? {})).map((name) => ({
            name,
          })),
        };
      } catch (error) {
        invalid = true;
        throw error;
      }
    },
    assertComplete() {
      if (invalid || next !== records.length)
        throw new Error('Database calls do not match recording');
    },
  };
}
