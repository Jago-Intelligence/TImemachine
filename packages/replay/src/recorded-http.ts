import type { HttpRecording } from '@timemachine/core';

/** Sequential matching per endpoint, with no network fallback. */
export function createRecordedHttpFetch(recording: HttpRecording): {
  fetch: typeof globalThis.fetch;
  assertComplete(): void;
} {
  const used = new Set<number>();
  let invalid = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? String(input) : input.url,
      );
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        [
          ...new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          ).keys(),
        ].some((key) => !['accept', 'content-type'].includes(key)) ||
        init?.body ||
        (input instanceof Request && input.body)
      )
        throw new Error('Unsupported recorded HTTP input');
      const index = recording.dependencies.findIndex(
        (row, index) =>
          !used.has(index) &&
          row.method === method &&
          row.origin === url.origin &&
          row.route === url.pathname,
      );
      if (index < 0) throw new Error('Unexpected HTTP dependency');
      const row = recording.dependencies[index]!;
      if (row.partial || row.result !== 'response' || row.statusCode === null)
        throw new Error('Incomplete recorded HTTP dependency');
      used.add(index);
      return new Response(
        [204, 205, 304].includes(row.statusCode) ? null : JSON.stringify(row.body),
        {
          status: row.statusCode,
          headers: { 'content-type': 'application/json' },
        },
      );
    } catch (error) {
      invalid = true;
      throw error;
    }
  };
  return {
    fetch,
    assertComplete() {
      if (invalid || used.size !== recording.dependencies.length)
        throw new Error('Recorded dependency calls do not match');
    },
  };
}
