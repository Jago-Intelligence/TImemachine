import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { installExpressErrorObserver } from '../src/express-errors.js';
import { createExpressInstrumentation, type ExpressRequest } from '../src/express.js';
import type { TimeMachineClient } from '../src/types.js';
import { projectFrames } from '../src/frames.js';

const entry = resolve('../../examples/express-delivery/src/main.js');
it('captures Express forwarded errors with project source frames and preserves the responder', () => {
  const appRequire = createRequire(entry);
  const expressRequire = createRequire(appRequire.resolve('express'));
  const Layer = expressRequire('router/lib/layer');
  const original = Layer.prototype.handleError;
  const captureException = vi.fn<TimeMachineClient['captureException']>(() => ({
    queued: true as const,
    incidentId: 'test',
  }));
  const tm = createExpressInstrumentation({ captureException });
  const observer = installExpressErrorObserver(tm.errorHandler, entry);
  expect(observer.enabled).toBe(true);
  const request = {
    method: 'POST',
    route: { path: '/delivery/quote' },
  } as ExpressRequest;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 500,
    writableFinished: false,
    headersSent: false,
    setHeader: vi.fn(),
  }) as unknown as ServerResponse;
  tm.middleware(request, response, () => {});
  const error = new TypeError('private error value');
  const responder = vi.fn(function (
    _error: unknown,
    _request: unknown,
    reply: ServerResponse,
    next: unknown,
  ) {
    void next;
    Object.assign(reply, { writableFinished: true });
    reply.emit('finish');
  });
  try {
    const layer = new Layer('/', {}, responder);
    layer.handleError(error, request, response, vi.fn());
    expect(responder).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException.mock.calls[0]?.[0]).toBe(error);
    expect(projectFrames(error, resolve('../..')).length).toBeGreaterThan(0);
  } finally {
    observer.restore();
  }
  expect(Layer.prototype.handleError).toBe(original);
});
it('leaves non-Express entrypoints alone', () => {
  expect(installExpressErrorObserver(() => {}, '/tmp/unrelated/app.js').enabled).toBe(
    false,
  );
});
