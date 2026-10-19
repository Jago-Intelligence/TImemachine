import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { INCIDENT_LIMITS, timelineEventSchema } from '@timemachine/core';
import type { CaptureContext, CaptureResult, HttpHandler } from './types.js';

export function wrapHandler(
  route: string,
  handler: HttpHandler,
  capture: (error: unknown, context: CaptureContext) => CaptureResult,
): HttpHandler {
  if (
    !timelineEventSchema.safeParse({
      id: 'route-check',
      type: 'http.request',
      method: 'GET',
      route,
      offsetMs: 0,
    }).success
  ) {
    throw new Error('Use a sanitized HTTP route template');
  }
  return (request, response) => {
    const started = performance.now();
    const requestId = randomUUID();
    let thrown = false;
    let error: unknown;
    let captured = false;
    let errorAt: string | undefined;
    let errorOffsetMs: number | undefined;
    const report = () => {
      if (captured) return;
      captured = true;
      const http: CaptureContext['http'] = {
        method: request.method as NonNullable<CaptureContext['http']>['method'],
        route,
        durationMs: Math.min(
          Math.max(0, Math.round(performance.now() - started)),
          INCIDENT_LIMITS.durationMs,
        ),
        ...(errorOffsetMs === undefined ? {} : { errorOffsetMs }),
        ...(response.writableFinished ? { statusCode: response.statusCode } : {}),
      };
      capture(error, {
        requestId,
        ...(errorAt ? { occurredAt: errorAt } : {}),
        correlationId: requestId,
        code: thrown ? 'HTTP_HANDLER_ERROR' : `HTTP_${response.statusCode}`,
        http,
      });
    };
    const onFinish = () => {
      response.off('close', onClose);
      if (thrown || response.statusCode >= 500) report();
    };
    const onClose = () => {
      response.off('finish', onFinish);
      if (thrown) report();
    };
    response.once('finish', onFinish);
    response.once('close', onClose);
    const onFailure = (failure: unknown) => {
      thrown = true;
      errorAt = new Date().toISOString();
      errorOffsetMs = Math.min(
        INCIDENT_LIMITS.durationMs,
        Math.max(0, Math.round(performance.now() - started)),
      );
      error = failure;
      if (response.writableFinished || response.destroyed) report();
      else if (response.headersSent) {
        report();
        response.destroy();
      } else {
        response.statusCode = 500;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end('Internal Server Error');
      }
    };
    try {
      void Promise.resolve(handler(request, response)).catch(onFailure);
    } catch (failure) {
      onFailure(failure);
    }
  };
}
