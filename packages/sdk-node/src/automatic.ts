import { installPostgresObserver } from './postgres.js';
import { installExpressErrorObserver } from './express-errors.js';
import type { RecordingPolicy } from './recording-policy.js';
import type { ServerResponse } from 'node:http';
import { Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { createExpressInstrumentation, type ExpressRequest } from './express.js';
import type { TimeMachineClient } from './types.js';

let active: ReturnType<typeof createExpressInstrumentation> | undefined;
export function automaticClientAdapters() {
  if (!active)
    throw new Error(
      'Start the app with TimeMachine recording before wrapping dependency clients',
    );
  return { ...active.clients, axios: active.axios.bind(active) };
}

/** Node HTTP/Express request observation and native global fetch instrumentation. */
export function installAutomaticRecording(
  sdk: TimeMachineClient,
  recordingPolicy?: RecordingPolicy,
) {
  const originalEmit = Server.prototype.emit;
  const originalFetch = globalThis.fetch;
  const tm = createExpressInstrumentation(sdk, {
    ...(recordingPolicy ? { recordingPolicy } : {}),
  });
  active = tm;
  const postgres = installPostgresObserver(
    tm.getPostgresScope,
    recordingPolicy?.postgres,
  );
  const errors = installExpressErrorObserver(tm.errorHandler);
  const recordedFetch = tm.fetch('outbound-http', 'fetch', originalFetch);
  globalThis.fetch = recordedFetch;
  const emit = function (this: Server, event: string, ...args: unknown[]): boolean {
    if (event !== 'request' || !args[0] || !args[1])
      return Reflect.apply(originalEmit, this, [event, ...args]);
    let result = false;
    tm.middleware(args[0] as ExpressRequest, args[1] as ServerResponse, () => {
      result = Reflect.apply(originalEmit, this, [event, ...args]);
    });
    return result;
  };
  Server.prototype.emit = emit as typeof originalEmit;
  syncBuiltinESMExports();
  return {
    expressErrors: errors.enabled,
    postgres: postgres.enabled,
    restore() {
      if (active === tm) active = undefined;
      errors.restore();
      postgres.restore();
      if (Server.prototype.emit === emit) Server.prototype.emit = originalEmit;
      if (globalThis.fetch === recordedFetch) globalThis.fetch = originalFetch;
      syncBuiltinESMExports();
    },
  };
}
