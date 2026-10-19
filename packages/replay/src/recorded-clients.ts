import { createHash } from 'node:crypto';
import {
  operationRecordingSchema,
  operationSelector,
  operationValuesSchema,
  type OperationRecording,
} from '@timemachine/core';

export function createRecordedClients(input: readonly OperationRecording[]) {
  if (input.length > 20) throw new Error('Too many operation fixtures');
  const records = input.map((row) => operationRecordingSchema.parse(row));
  const used = new Set<number>();
  let invalid = false;
  const jobs: {
    queue: string;
    name: string;
    id: string;
    data: Record<string, unknown>;
  }[] = [];
  async function consume(
    kind: OperationRecording['kind'],
    operation: OperationRecording['operation'],
    selector: string,
    values: unknown,
    extra = false,
  ) {
    try {
      const normalized = operationSelector(kind, operation, selector);
      if (!normalized || extra) throw new Error('Unsupported operation input');
      const hash = createHash('sha256')
        .update(`${kind}:${operation}:${normalized}`)
        .digest('hex');
      const index = records.findIndex(
        (row, i) =>
          !used.has(i) &&
          row.kind === kind &&
          row.operation === operation &&
          row.selectorHash === hash,
      );
      if (index < 0) throw new Error('Unexpected dependency operation');
      const row = records[index]!;
      if (row.partial || row.result !== 'rows')
        throw new Error('Incomplete operation fixture');
      const keys = row.inputOrder ?? Object.keys(row.input);
      if (
        new Set(keys).size !== keys.length ||
        keys.length !== Object.keys(row.input).length ||
        keys.some((key) => !Object.hasOwn(row.input, key))
      )
        throw new Error('Invalid parameter order');
      let selected: unknown = values;
      if (Array.isArray(values)) {
        if (
          Object.values(Object.getOwnPropertyDescriptors(values)).some(
            (d) => !('value' in d),
          )
        )
          throw new Error('Unsupported parameters');
        if (values.length !== keys.length) throw new Error('Changed parameters');
        selected = Object.fromEntries(keys.map((key, i) => [key, values[i]]));
      }
      // Reject getters/proxies rather than executing them during fixture matching.
      if (
        !selected ||
        typeof selected !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(selected)) ||
        Object.values(Object.getOwnPropertyDescriptors(selected)).some(
          (d) => !('value' in d),
        )
      )
        throw new Error('Unsupported parameters');
      const safe = operationValuesSchema.parse(selected);
      if (
        Object.keys(safe).length !== keys.length ||
        keys.some(
          (key) => !Object.hasOwn(safe, key) || !Object.is(safe[key], row.input[key]),
        )
      )
        throw new Error('Changed dependency input');
      used.add(index);
      return structuredClone(row);
    } catch (error) {
      invalid = true;
      throw error;
    }
  }
  const mysql = {
    async query(text: string, values: unknown[] = []) {
      const row = await consume('mysql', 'query', text, values);
      return [
        row.rows,
        (row.fields ?? Object.keys(row.rows[0] ?? {})).map((name) => ({ name })),
      ] as const;
    },
    async execute(text: string, values: unknown[] = []) {
      const row = await consume('mysql', 'execute', text, values);
      return [
        row.rows,
        (row.fields ?? Object.keys(row.rows[0] ?? {})).map((name) => ({ name })),
      ] as const;
    },
  };
  const mongodb = {
    collection(name: string) {
      return {
        async findOne(filter: unknown, options?: unknown) {
          const row = await consume(
            'mongodb',
            'findOne',
            name,
            filter,
            options === undefined ||
              !options ||
              typeof options !== 'object' ||
              Object.keys(options).some((key) => key !== 'projection'),
          );
          if (options && typeof options === 'object') {
            const descriptor = Object.getOwnPropertyDescriptor(options, 'projection');
            const projection =
              descriptor && 'value' in descriptor ? descriptor.value : undefined;
            if (
              !projection ||
              typeof projection !== 'object' ||
              Object.values(Object.getOwnPropertyDescriptors(projection)).some(
                (d) => !('value' in d),
              ) ||
              !Object.hasOwn(projection, '_id') ||
              Object.entries(projection).some(([key, value]) =>
                key === '_id'
                  ? value !== 0 && value !== false
                  : !row.fields?.includes(key) || (value !== 1 && value !== true),
              ) ||
              row.fields?.some((key) => !Object.hasOwn(projection, key))
            ) {
              invalid = true;
              throw new Error('Changed projection');
            }
          }
          return row.rows[0] ?? null;
        },
      };
    },
  };
  const queues = {
    queue(name: string) {
      return {
        async add(job: string, data: unknown, options?: unknown) {
          const row = await consume(
            'bullmq',
            'add',
            `${name}/${job}`,
            data,
            options !== undefined &&
              (!options ||
                typeof options !== 'object' ||
                Object.keys(options).length !== 0),
          );
          const id = row.rows[0]?.jobId;
          if (typeof id !== 'string') {
            invalid = true;
            throw new Error('Missing queue acknowledgment');
          }
          const submitted = {
            queue: name,
            name: job,
            id,
            data: structuredClone(row.input),
          };
          jobs.push(submitted);
          return { id, name: job, data: structuredClone(row.input) };
        },
      };
    },
    submittedJobs() {
      return structuredClone(jobs);
    },
  };
  return {
    mysql,
    mongodb,
    queues,
    assertComplete() {
      if (invalid || used.size !== records.length)
        throw new Error('Recorded operations do not match');
    },
  };
}

export function createRecordedAxiosAdapter(fetcher: typeof fetch) {
  return async <T>(raw: T) => {
    const config = raw as {
      url?: string;
      baseURL?: string;
      method?: string;
      params?: unknown;
      data?: unknown;
      auth?: unknown;
      proxy?: unknown;
      responseType?: string;
      headers?: Record<string, unknown> & { toJSON?: () => Record<string, unknown> };
      validateStatus?: (status: number) => boolean;
    };
    const url = new URL(config.url ?? '', config.baseURL);
    const headers = new Headers();
    const supplied =
      typeof config.headers?.toJSON === 'function'
        ? config.headers.toJSON()
        : (config.headers ?? {});
    for (const [key, value] of Object.entries(supplied))
      if (value !== undefined && value !== null && value !== false)
        headers.set(key, 'omitted');
    if (
      config.params ||
      config.auth ||
      (config.proxy !== undefined && config.proxy !== false) ||
      (config.responseType && !['json', 'text'].includes(config.responseType))
    )
      headers.set('x-timemachine-unsupported', 'true');
    const response = await fetcher(url, {
      method: (config.method ?? 'GET').toUpperCase(),
      headers,
      ...(config.data === undefined || config.data === null ? {} : { body: 'omitted' }),
    });
    const result = {
      data: await response.text(),
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      config: raw,
      request: {},
    };
    const accepted = config.validateStatus
      ? config.validateStatus(response.status)
      : response.status >= 200 && response.status < 300;
    if (!accepted)
      throw Object.assign(new Error('Recorded HTTP response rejected'), {
        name: 'AxiosError',
        isAxiosError: true,
        code: response.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
        response: result,
        config: raw,
      });
    return result;
  };
}
