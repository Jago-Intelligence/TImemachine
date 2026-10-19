import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  normalizePostgresQuery,
  postgresScalarSchema,
  postgresRecordingSchema,
  type PostgresRecording,
} from '@timemachine/core';
import { projectBody, type RecordingPolicy } from './recording-policy.js';

export interface PgRecordScope {
  body: unknown;
  ended: boolean;
  synthetic?: boolean;
  postgres: PostgresRecording[];
  truncated: boolean;
  addTimeline(id: string, failed: boolean, start: number): void;
}
type Query = (this: unknown, ...args: unknown[]) => unknown;
export function observePostgresQuery(
  original: Query,
  receiver: unknown,
  args: unknown[],
  state: PgRecordScope | undefined,
  policy: RecordingPolicy['postgres'],
) {
  if (!state || state.ended || state.synthetic)
    return Reflect.apply(original, receiver, args);
  const start = performance.now();
  let text: unknown,
    config: Record<string, unknown> | undefined,
    unsafe = false;
  if (typeof args[0] === 'string') text = args[0];
  else if (args[0] && typeof args[0] === 'object') {
    try {
      const descriptors = Object.getOwnPropertyDescriptors(args[0]);
      unsafe = Object.values(descriptors).some((value) => !('value' in value));
      if (!unsafe) {
        config = Object.fromEntries(
          Object.entries(descriptors).map(([key, value]) => [key, value.value]),
        );
        text = config.text;
      }
    } catch {
      unsafe = true;
    }
  }
  const normalized = typeof text === 'string' ? normalizePostgresQuery(text) : undefined;
  const rule = normalized
    ? policy?.find((rule) => normalizePostgresQuery(rule.text) === normalized)
    : undefined;
  const values = Array.isArray(args[1]) ? args[1] : (config?.values ?? []);
  const unsupported =
    unsafe ||
    args.some((arg) => typeof arg === 'function') ||
    (config && Object.keys(config).some((key) => !['text', 'values'].includes(key)));
  if (
    !rule ||
    !normalized ||
    unsupported ||
    !Array.isArray(values) ||
    values.length > 20 ||
    state.postgres.length >= 10
  ) {
    state.truncated = true;
    return Reflect.apply(original, receiver, args);
  }
  const selected = projectBody(state.body, rule.parameterFields).body;
  const parameters = Array.from(values).map((value) =>
    postgresScalarSchema.safeParse(value),
  );
  const bound =
    values.length === rule.parameterFields.length &&
    parameters.every((item) => item.success) &&
    Buffer.byteLength(JSON.stringify(values)) <= 2048 &&
    values.every(
      (value, index) =>
        Object.prototype.hasOwnProperty.call(selected, rule.parameterFields[index]!) &&
        Object.is(value, selected[rule.parameterFields[index]!]),
    );
  const entry: PostgresRecording = {
    id: rule.id,
    queryHash: createHash('sha256').update(normalized).digest('hex'),
    parameters: bound ? parameters.map((item) => item.data!) : [],
    rows: [],
    rowCount: null,
    result: 'omitted',
    partial: true,
  };
  state.postgres.push(entry);
  const success = (result: unknown) => {
    if (!state.ended) {
      if (!bound) {
        state.addTimeline(rule.id, false, start);
        return result;
      }
      try {
        if (
          !result ||
          typeof result !== 'object' ||
          !('rows' in result) ||
          !Array.isArray(result.rows) ||
          result.rows.length > 20 ||
          !('command' in result) ||
          result.command !== 'SELECT'
        )
          throw new Error('Unsupported result');
        const projected = result.rows.map((row) => projectBody(row, rule.rowFields));
        entry.rows = projected.map((row) => row.body);
        entry.rowCount =
          'rowCount' in result && typeof result.rowCount === 'number'
            ? result.rowCount
            : null;
        entry.result = 'rows';
        entry.partial =
          !bound ||
          projected.some((row) => row.partial) ||
          entry.rowCount !== result.rows.length;
        if ('fields' in result && Array.isArray(result.fields)) {
          entry.fields = result.fields
            .filter(
              (field) =>
                field &&
                typeof field === 'object' &&
                'name' in field &&
                rule.rowFields.includes(String(field.name)),
            )
            .map((field) => String(field.name));
          entry.partial ||= result.fields.some(
            (field) =>
              !field ||
              typeof field !== 'object' ||
              !('name' in field) ||
              !rule.rowFields.includes(String(field.name)),
          );
        }
        if (Buffer.byteLength(JSON.stringify(entry)) > 4096)
          throw new Error('Result too large');
        postgresRecordingSchema.parse(entry);
      } catch {
        entry.rows = [];
        entry.rowCount = null;
        delete entry.fields;
        entry.partial = true;
        entry.result = 'omitted';
      }
      state.addTimeline(rule.id, false, start);
    }
    return result;
  };
  const failure = (error: unknown) => {
    if (!state.ended) {
      let code: string | undefined;
      try {
        const descriptor =
          error && typeof error === 'object'
            ? Object.getOwnPropertyDescriptor(error, 'code')
            : undefined;
        code =
          descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
            ? descriptor.value
            : undefined;
      } catch {
        /* Never replace an application's error with an inspection failure. */
      }
      const valid = postgresRecordingSchema.shape.errorCode.safeParse(code);
      entry.result = 'error';
      entry.partial = !bound || !valid.success || !code;
      if (valid.success && code) entry.errorCode = code;
      state.addTimeline(rule.id, true, start);
    }
    throw error;
  };
  try {
    const result = Reflect.apply(original, receiver, args);
    if (!(result instanceof Promise)) {
      state.truncated = true;
      return result;
    }
    return result.then(success, failure);
  } catch (error) {
    return failure(error);
  }
}

/** Patches pg 8 public query methods; nested Pool → Client calls are observed once. */
export function installPostgresObserver(
  getScope: () => PgRecordScope | undefined,
  policy?: RecordingPolicy['postgres'],
  entrypoint = process.argv[1],
) {
  if (!entrypoint || !existsSync(resolve(entrypoint)))
    return { enabled: false, restore() {} };
  try {
    const require = createRequire(resolve(entrypoint));
    const pg = require('pg') as {
      Client: { prototype: { query: Query } };
      Pool: { prototype: { query: Query } };
    };
    const pgRequire = createRequire(require.resolve('pg'));
    const version = pgRequire('../package.json').version as string;
    if (!version.startsWith('8.')) return { enabled: false, restore() {} };
    const nested = new AsyncLocalStorage<boolean>();
    const restores: Array<() => void> = [];
    for (const prototype of [pg.Client.prototype, pg.Pool.prototype]) {
      const original = prototype.query;
      const wrapped: Query = function (...args) {
        if (nested.getStore()) return Reflect.apply(original, this, args);
        const delegate: Query = (...input) =>
          nested.run(true, () => Reflect.apply(original, this, input));
        return observePostgresQuery(delegate, this, args, getScope(), policy);
      };
      prototype.query = wrapped;
      restores.push(() => {
        if (prototype.query === wrapped) prototype.query = original;
      });
    }
    return {
      enabled: true,
      restore() {
        restores.reverse().forEach((restore) => restore());
      },
    };
  } catch {
    return { enabled: false, restore() {} };
  }
}
