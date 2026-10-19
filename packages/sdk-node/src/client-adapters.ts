import { createHash } from 'node:crypto';
import {
  operationRecordingSchema,
  operationSelector,
  operationValuesSchema,
  type OperationRule,
  type OperationRecording,
} from '@timemachine/core';
import { projectBody } from './recording-policy.js';
export interface OperationScope {
  body: unknown;
  ended: boolean;
  records: OperationRecording[];
  truncate(): void;
  pending(promise: Promise<void>): void;
  timeline(id: string, failed: boolean, started: number): void;
}
export function createClientAdapters(
  getScope: () => OperationScope | undefined,
  rules: readonly OperationRule[] = [],
) {
  function record<T>(
    kind: OperationRecording['kind'],
    operation: OperationRecording['operation'],
    selector: string,
    values: unknown,
    invoke: () => Promise<T>,
    resultRows: (result: T) => { rows: unknown[]; fields?: string[] },
    unsupported = false,
  ): Promise<T> {
    const scope = getScope();
    if (!scope || scope.ended) return invoke();
    const started = performance.now();
    const normalized = operationSelector(kind, operation, selector);
    const rule = rules.find(
      (rule) =>
        rule.kind === kind &&
        rule.operation === operation &&
        operationSelector(kind, operation, rule.selector) === normalized,
    );
    if (!normalized || !rule || scope.records.length >= 20) {
      scope.truncate();
      return invoke();
    }
    let input: Record<string, unknown> = {},
      partial = unsupported;
    try {
      if (Array.isArray(values)) {
        if (
          values.length !== rule.inputFields.length ||
          Object.values(Object.getOwnPropertyDescriptors(values)).some(
            (d) => !('value' in d),
          )
        )
          partial = true;
        input = partial
          ? {}
          : Object.fromEntries(
              rule.inputFields.map((key, i) => [
                key,
                Object.getOwnPropertyDescriptor(values, String(i))?.value,
              ]),
            );
      } else {
        const selected = projectBody(values, rule.inputFields);
        input = selected.body;
        partial ||= selected.partial;
      }
      const safe = operationValuesSchema.safeParse(input);
      const request = projectBody(scope.body, rule.inputFields).body;
      if (
        !safe.success ||
        Object.keys(input).length !== rule.inputFields.length ||
        rule.inputFields.some(
          (key) => !Object.hasOwn(request, key) || !Object.is(request[key], input[key]),
        ) ||
        Buffer.byteLength(JSON.stringify(input)) > 2048
      ) {
        input = {};
        partial = true;
      }
    } catch {
      input = {};
      partial = true;
    }
    const entry: OperationRecording = {
      id: rule.id,
      kind,
      operation,
      selectorHash: createHash('sha256')
        .update(`${kind}:${operation}:${normalized}`)
        .digest('hex'),
      input: partial ? {} : operationValuesSchema.parse(input),
      ...(kind === 'mysql' ? { inputOrder: [...rule.inputFields] } : {}),
      rows: [],
      result: 'omitted',
      partial: true,
    };
    scope.records.push(entry);
    let failed = true;
    let returned: Promise<T>;
    try {
      returned = invoke();
    } catch (error) {
      entry.result = 'error';
      scope.timeline(rule.id, true, started);
      throw error;
    }
    if (!(returned instanceof Promise)) {
      scope.truncate();
      return returned;
    }
    const result = returned.then(
      (value) => {
        failed = false;
        try {
          const selected = resultRows(value);
          if (partial || selected.rows.length > 20) return value;
          const rows = selected.rows.map((row) => projectBody(row, rule.resultFields));
          entry.rows = rows.map((row) => row.body);
          entry.partial = rows.some((row) => row.partial);
          entry.result = 'rows';
          if (selected.fields) {
            entry.fields = selected.fields;
            if (selected.fields.some((key) => !rule.resultFields.includes(key)))
              entry.partial = true;
          }
          if (Buffer.byteLength(JSON.stringify(entry)) > 4096)
            throw new Error('Too large');
          operationRecordingSchema.parse(entry);
        } catch {
          entry.rows = [];
          delete entry.fields;
          entry.partial = true;
          entry.result = 'omitted';
        }
        return value;
      },
      (error) => {
        entry.result = 'error';
        throw error;
      },
    );
    scope.pending(
      result
        .then(
          () => {},
          () => {},
        )
        .finally(() => scope.timeline(rule.id, failed, started)),
    );
    return result;
  }
  function mongoOptions(name: string, options: unknown) {
    try {
      const rule = rules.find(
        (rule) =>
          rule.kind === 'mongodb' &&
          rule.operation === 'findOne' &&
          rule.selector === name,
      );
      if (
        !rule ||
        !options ||
        typeof options !== 'object' ||
        Object.keys(options).some((key) => key !== 'projection')
      )
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(options, 'projection');
      const projection =
        descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (
        !projection ||
        typeof projection !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(projection))
      )
        return false;
      const fields = Object.getOwnPropertyDescriptors(projection);
      if (Object.values(fields).some((field) => !('value' in field))) return false;
      return (
        (fields._id?.value === 0 || fields._id?.value === false) &&
        Object.keys(fields).every(
          (key) =>
            key === '_id' ||
            (rule.resultFields.includes(key) && [1, true].includes(fields[key]?.value)),
        ) &&
        rule.resultFields.every(
          (key) => fields[key] && [1, true].includes(fields[key]?.value),
        )
      );
    } catch {
      return false;
    }
  }
  return {
    mysql<T extends object>(client: T): T {
      return new Proxy(client, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (!['query', 'execute'].includes(String(key)) || typeof value !== 'function')
            return typeof value === 'function'
              ? (...args: unknown[]) => {
                  const scope = getScope();
                  if (scope && !scope.ended) scope.truncate();
                  return Reflect.apply(value, target, args);
                }
              : value;
          return (text: unknown, values: unknown = [], ...extra: unknown[]) => {
            if (
              typeof values === 'function' ||
              extra.some((arg) => typeof arg === 'function')
            ) {
              getScope()?.truncate();
              return Reflect.apply(value, target, [text, values, ...extra]);
            }
            return record(
              'mysql',
              key as 'query' | 'execute',
              typeof text === 'string' ? text : '',
              values,
              () => Reflect.apply(value, target, [text, values, ...extra]),
              (result) => {
                if (!Array.isArray(result) || !Array.isArray(result[0]))
                  throw new Error('Unsupported mysql result');
                return {
                  rows: result[0],
                  ...(Array.isArray(result[1])
                    ? {
                        fields: result[1].map(
                          (field) =>
                            Object.getOwnPropertyDescriptor(field, 'name')?.value,
                        ),
                      }
                    : {}),
                };
              },
              extra.length > 0 || !Array.isArray(values),
            );
          };
        },
      });
    },
    mongodb<T extends object>(collection: T, name: string): T {
      return new Proxy(collection, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key !== 'findOne' || typeof value !== 'function')
            return typeof value === 'function'
              ? (...args: unknown[]) => {
                  const scope = getScope();
                  if (scope && !scope.ended) scope.truncate();
                  return Reflect.apply(value, target, args);
                }
              : value;
          return (filter: unknown, options?: unknown, ...extra: unknown[]) =>
            record(
              'mongodb',
              'findOne',
              name,
              filter,
              () => Reflect.apply(value, target, [filter, options, ...extra]),
              (result) => ({
                rows: result === null ? [] : [result],
                fields:
                  rules.find(
                    (rule) =>
                      rule.kind === 'mongodb' &&
                      rule.operation === 'findOne' &&
                      rule.selector === name,
                  )?.resultFields ?? [],
              }),
              extra.length > 0 || !mongoOptions(name, options),
            );
        },
      });
    },
    bullmq<T extends object>(queue: T, name: string): T {
      return new Proxy(queue, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key !== 'add' || typeof value !== 'function')
            return typeof value === 'function'
              ? (...args: unknown[]) => {
                  const scope = getScope();
                  if (scope && !scope.ended) scope.truncate();
                  return Reflect.apply(value, target, args);
                }
              : value;
          return (job: string, data: unknown, options?: unknown, ...extra: unknown[]) =>
            record(
              'bullmq',
              'add',
              `${name}/${job}`,
              data,
              () => Reflect.apply(value, target, [job, data, options, ...extra]),
              (result) => {
                const descriptor =
                  result && typeof result === 'object'
                    ? Object.getOwnPropertyDescriptor(result, 'id')
                    : undefined;
                if (
                  !descriptor ||
                  !('value' in descriptor) ||
                  typeof descriptor.value !== 'string'
                )
                  throw new Error('Unsupported job id');
                return { rows: [{ jobId: descriptor.value }] };
              },
              extra.length > 0 ||
                (options !== undefined &&
                  (!options ||
                    typeof options !== 'object' ||
                    Object.keys(options).length > 0)),
            );
        },
      });
    },
  };
}
