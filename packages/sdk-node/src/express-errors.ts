import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ExpressRequest } from './express.js';
import type { ServerResponse } from 'node:http';

type Observe = (
  error: unknown,
  request: ExpressRequest,
  response: ServerResponse,
  next: () => void,
) => void;
type HandleError = (
  this: object,
  error: unknown,
  request: ExpressRequest,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => unknown;
export function installExpressErrorObserver(
  observe: Observe,
  entrypoint = process.argv[1],
) {
  if (!entrypoint || !existsSync(resolve(entrypoint)))
    return { enabled: false, restore() {} };
  try {
    const appRequire = createRequire(resolve(entrypoint));
    const expressRequire = createRequire(appRequire.resolve('express'));
    const expressVersion: unknown = expressRequire('./package.json');
    if (
      typeof expressVersion !== 'object' ||
      !expressVersion ||
      !('version' in expressVersion) ||
      typeof expressVersion.version !== 'string' ||
      !expressVersion.version.startsWith('5.')
    )
      return { enabled: false, restore() {} };
    const routerVersion: unknown = expressRequire('router/package.json');
    if (
      typeof routerVersion !== 'object' ||
      !routerVersion ||
      !('version' in routerVersion) ||
      typeof routerVersion.version !== 'string' ||
      !routerVersion.version.startsWith('2.')
    )
      return { enabled: false, restore() {} };
    const Layer = expressRequire('router/lib/layer') as {
      prototype: { handleError: HandleError };
    };
    const original = Layer.prototype.handleError;
    if (typeof original !== 'function') return { enabled: false, restore() {} };
    const wrapped: HandleError = function (error, request, response, next) {
      // Observation must never replace the application's error handling.
      try {
        observe(error, request, response, () => {});
      } catch {
        /* Capture is best effort. */
      }
      return Reflect.apply(original, this, [error, request, response, next]);
    };
    Layer.prototype.handleError = wrapped;
    return {
      enabled: true,
      restore() {
        if (Layer.prototype.handleError === wrapped)
          Layer.prototype.handleError = original;
      },
    };
  } catch {
    return { enabled: false, restore() {} };
  }
}
