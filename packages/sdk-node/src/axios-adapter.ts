export function installAxiosRecording<T extends object>(
  client: T,
  record: (implementation: typeof fetch) => typeof fetch,
  resolveAdapter?: object,
) {
  const defaults = Reflect.get(client, 'defaults') as { adapter: unknown } | undefined;
  const resolver = resolveAdapter ?? Reflect.get(client, 'getAdapter');
  if (!defaults || typeof resolver !== 'function')
    throw new Error('Use an Axios client and its getAdapter resolver');
  const original = defaults.adapter;
  const transport = Reflect.apply(resolver, client, [original]);
  if (typeof transport !== 'function') throw new Error('Axios transport unavailable');
  const adapter = async (raw: unknown) => {
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
    };
    let url: URL;
    try {
      url = new URL(config.url ?? '', config.baseURL);
    } catch {
      url = new URL('http://invalid.timemachine.local/unsupported');
    }
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
      url.username ||
      url.password ||
      (config.responseType &&
        config.responseType !== 'json' &&
        config.responseType !== 'text')
    )
      headers.set('x-timemachine-unsupported', 'true');
    let actual:
      | {
          status: number;
          data: unknown;
          request?: unknown;
          headers?: Record<string, unknown>;
        }
      | undefined;
    let rejection: unknown;
    const wrapped = record(async () => {
      try {
        actual = await transport(raw);
      } catch (error) {
        const descriptor =
          error && typeof error === 'object'
            ? Object.getOwnPropertyDescriptor(error, 'response')
            : undefined;
        if (!descriptor || !('value' in descriptor) || !descriptor.value) throw error;
        actual = descriptor.value;
        rejection = error;
      }
      try {
        if (!actual) throw new Error('Invalid Axios response');
        const descriptors = Object.getOwnPropertyDescriptors(actual);
        if (
          ['status', 'data', 'headers', 'request'].some(
            (key) => descriptors[key] && !('value' in descriptors[key]!),
          )
        )
          throw new Error('Unsupported response getter');
        const status = descriptors.status?.value as number;
        const data = descriptors.data?.value as unknown;
        const responseHeaders = descriptors.headers?.value as
          Record<string, unknown> | undefined;
        const request = descriptors.request?.value as unknown;
        const selectedHeaders = new Headers();
        const own = (object: unknown, key: string) =>
          object && typeof object === 'object'
            ? Object.getOwnPropertyDescriptor(object, key)?.value
            : undefined;
        const responseUrl = own(own(request, 'res'), 'responseUrl');
        const redirects = own(own(request, '_redirectable'), '_redirectCount');
        if (
          (typeof responseUrl === 'string' && responseUrl !== url.href) ||
          (typeof redirects === 'number' && redirects > 0)
        )
          selectedHeaders.set('x-timemachine-unsupported-response', 'true');
        for (const [key, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(responseHeaders ?? {}),
        )) {
          if (!('value' in descriptor)) throw new Error('Unsupported response header');
          const value = descriptor.value;
          if (typeof value === 'string' || typeof value === 'number')
            selectedHeaders.set(key, String(value));
          else if (value !== undefined && value !== null)
            selectedHeaders.set('x-timemachine-unsupported-response', 'true');
        }
        let body = '';
        if (typeof data === 'string') body = data;
        else if (
          data &&
          typeof data === 'object' &&
          Object.getPrototypeOf(data) === Object.prototype
        ) {
          const descriptors = Object.getOwnPropertyDescriptors(data);
          if (
            Object.keys(descriptors).length > 40 ||
            Object.values(descriptors).some(
              (d) =>
                !('value' in d) ||
                (d.value !== null &&
                  !['string', 'number', 'boolean'].includes(typeof d.value)),
            )
          )
            throw new Error('Unsupported JSON data');
          body = JSON.stringify(data);
        }
        if (
          Buffer.byteLength(body) > 8192 ||
          (!body && ![204, 205, 304].includes(status))
        )
          throw new Error('Unsupported body');
        return new Response([204, 205, 304].includes(status) ? null : body, {
          status: status,
          headers: selectedHeaders,
        });
      } catch {
        // Recording failures never replace the application's transport result.
        return new Response('{}', {
          headers: { 'x-timemachine-unsupported-response': 'true' },
        });
      }
    });
    await wrapped(url, {
      method: (config.method ?? 'GET').toUpperCase(),
      headers,
      ...(config.data === undefined || config.data === null ? {} : { body: 'omitted' }),
    });
    if (rejection) throw rejection;
    return actual;
  };
  defaults.adapter = adapter;
  return () => {
    if (defaults.adapter === adapter) defaults.adapter = original;
  };
}
