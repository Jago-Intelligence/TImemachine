import { createClientAdapters, type OperationScope } from './client-adapters.js';
import { installAxiosRecording } from './axios-adapter.js';
import type { PgRecordScope } from './postgres.js';
import {
  recordingPolicySchema,
  projectBody,
  responseBody,
  type RecordingPolicy,
} from './recording-policy.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  INCIDENT_LIMITS,
  httpMethodSchema,
  routeSchema,
  replayFixtureSchema,
  fixtureContract,
  type ReplayFixture,
  type HttpRecording,
  type PostgresRecording,
} from '@timemachine/core';
import type { CaptureContext, CaptureResult, TimeMachineClient } from './types.js';

/** Structural types keep Express an optional application dependency. */
export interface ExpressRequest extends IncomingMessage {
  route?: { path?: unknown };
  body?: unknown;
}
type Next = (error?: unknown) => void;
interface RequestState {
  request: ExpressRequest;
  operations: NonNullable<HttpRecording['operations']>;
  postgres: PostgresRecording[];
  id: string;
  started: number;
  route?: string;
  error?: unknown;
  errorAt?: string;
  errorOffsetMs?: number;
  captured: boolean;
  fixture?: ReplayFixture;
  dependencies: NonNullable<CaptureContext['dependencies']>;
  finished: boolean;
  ended: boolean;
  durationMs?: number;
  recordings: HttpRecording['dependencies'];
  pending: Set<Promise<void>>;
  truncated: boolean;
}

export function createExpressInstrumentation(
  sdk: Pick<TimeMachineClient, 'captureException'>,
  options: { captureClientErrors?: boolean; recordingPolicy?: RecordingPolicy } = {},
) {
  const policy = options.recordingPolicy
    ? recordingPolicySchema.parse(options.recordingPolicy)
    : undefined;
  const scope = new AsyncLocalStorage<RequestState>();
  const httpTransportScope = new AsyncLocalStorage<boolean>();
  const states = new WeakMap<ExpressRequest, RequestState>();
  function http(request: ExpressRequest, response: ServerResponse, state: RequestState) {
    const method = httpMethodSchema.safeParse(request.method);
    // baseUrl and originalUrl can contain customer identifiers; never read them.
    const route = routeSchema.safeParse(state.route ?? request.route?.path);
    return method.success
      ? {
          method: method.data,
          route: route.success ? route.data : '/:unmatched',
          durationMs:
            state.durationMs ??
            Math.min(
              INCIDENT_LIMITS.durationMs,
              Math.max(0, Math.round(performance.now() - state.started)),
            ),
          ...(state.errorOffsetMs === undefined
            ? {}
            : { errorOffsetMs: state.errorOffsetMs }),
          ...(response.writableFinished ? { statusCode: response.statusCode } : {}),
        }
      : undefined;
  }
  function captureException(
    request: ExpressRequest,
    response: ServerResponse,
    error: unknown,
    context: CaptureContext = {},
  ): CaptureResult {
    const state = states.get(request);
    if (!state) return sdk.captureException(error, context);
    const requestHttp = context.http ?? http(request, response, state);
    const rule = policy?.requests.find(
      (rule) => rule.method === requestHttp?.method && rule.route === requestHttp?.route,
    );
    const projected = rule ? projectBody(request.body, rule.bodyFields) : undefined;
    if (
      projected &&
      (request.url?.includes('?') ||
        request.headers?.authorization ||
        request.headers?.cookie ||
        Object.keys(request.headers ?? {}).some(
          (key) =>
            ![
              'host',
              'connection',
              'content-length',
              'content-type',
              'accept',
              'accept-encoding',
              'user-agent',
            ].includes(key.toLowerCase()) &&
            !policy?.ignoredRequestHeaders?.includes(
              key.toLowerCase() as NonNullable<
                RecordingPolicy['ignoredRequestHeaders']
              >[number],
            ),
        ) ||
        (Number(request.headers?.['content-length']) > 0 && request.body === undefined))
    )
      projected.partial = true;
    const recording =
      rule && requestHttp
        ? {
            version: 1 as const,
            policyId: policy!.id,
            ...(rule.databaseMode ? { databaseMode: rule.databaseMode } : {}),
            ...(policy!.artifactId ? { artifactId: policy!.artifactId } : {}),
            request: {
              method: requestHttp.method,
              route: requestHttp.route,
              ...projected!,
            },
            dependencies: structuredClone(state.recordings),
            ...(state.operations.length
              ? { operations: structuredClone(state.operations) }
              : {}),
            ...(state.postgres.length
              ? { postgres: structuredClone(state.postgres) }
              : {}),
            truncated: state.truncated || state.pending.size > 0,
          }
        : undefined;
    while (
      recording &&
      Buffer.byteLength(JSON.stringify(recording)) > 60000 &&
      (recording.dependencies.length ||
        recording.postgres?.length ||
        recording.operations?.length)
    ) {
      recording.truncated = true;
      if (recording.operations?.length) recording.operations.pop();
      else if (recording.postgres?.length) recording.postgres.pop();
      else recording.dependencies.pop();
    }
    const result = sdk.captureException(error, {
      ...context,
      dependencies: state.dependencies.slice(),
      ...(recording ? { recording } : {}),
      requestId: state.id,
      correlationId: state.id,
      ...(context.occurredAt || state.errorAt
        ? { occurredAt: context.occurredAt ?? state.errorAt! }
        : {}),
      ...(requestHttp ? { http: requestHttp } : {}),
    });
    // A rejected explicit capture must not suppress the automatic fallback.
    if (result.queued) state.captured = true;
    return result;
  }
  const clients = createClientAdapters((): OperationScope | undefined => {
    const state = scope.getStore();
    if (!state || state.ended) return;
    return {
      body: Object.getOwnPropertyDescriptor(state.request, 'body')?.value,
      ended: state.ended,
      records: state.operations,
      truncate: () => {
        state.truncated = true;
      },
      pending: (promise) => {
        state.pending.add(promise);
        void promise.finally(() => state.pending.delete(promise));
      },
      timeline: (id, failed, started) => {
        if (state.dependencies.length >= 100) {
          state.truncated = true;
          return;
        }
        state.dependencies.push({
          dependencyId: id,
          operation: 'adapter-call',
          outcome: failed ? 'failure' : 'success',
          offsetMs: Math.min(
            INCIDENT_LIMITS.durationMs,
            Math.max(0, Math.round(started - state.started)),
          ),
          durationMs: Math.min(
            INCIDENT_LIMITS.durationMs,
            Math.max(0, Math.round(performance.now() - started)),
          ),
        });
      },
    };
  }, policy?.operations);
  return {
    clients,
    axios<T extends object>(client: T, resolver?: object) {
      return installAxiosRecording(
        client,
        (implementation) =>
          this.fetch('axios-http', 'request', (input, init) =>
            httpTransportScope.run(true, () => implementation(input, init)),
          ),
        resolver,
      );
    },
    getPostgresScope(): PgRecordScope | undefined {
      const state = scope.getStore();
      if (!state || state.ended) return;
      const synthetic =
        policy?.requests.some(
          (rule) =>
            rule.databaseMode === 'synthetic-postgres' &&
            rule.method === state.request.method &&
            rule.route === state.request.route?.path,
        ) ?? false;
      return {
        synthetic,
        get body() {
          const descriptor = Object.getOwnPropertyDescriptor(state.request, 'body');
          return descriptor && 'value' in descriptor ? descriptor.value : undefined;
        },
        get ended() {
          return state.ended;
        },
        postgres: state.postgres,
        get truncated() {
          return state.truncated;
        },
        set truncated(value) {
          state.truncated = value;
        },
        addTimeline(id, failed, start) {
          if (state.dependencies.length >= 100) {
            state.truncated = true;
            return;
          }
          state.dependencies.push({
            dependencyId: id,
            operation: 'query',
            outcome: failed ? 'failure' : 'success',
            offsetMs: Math.min(
              INCIDENT_LIMITS.durationMs,
              Math.max(0, Math.round(start - state.started)),
            ),
            durationMs: Math.min(
              INCIDENT_LIMITS.durationMs,
              Math.max(0, Math.round(performance.now() - start)),
            ),
          });
        },
      };
    },
    /** Wrap an application's fetch dependency once; labels must be reviewed constants. */
    fetch(
      dependencyId: string,
      operation: string,
      implementation: typeof fetch = globalThis.fetch,
    ): typeof fetch {
      const label = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
      if (!label.test(dependencyId) || !label.test(operation))
        throw new Error('Invalid dependency label');
      return async (input, init) => {
        if (httpTransportScope.getStore()) return implementation(input, init);
        const state = scope.getStore();
        const started = performance.now();
        const offsetMs = state
          ? Math.min(
              INCIDENT_LIMITS.durationMs,
              Math.max(0, Math.round(started - state.started)),
            )
          : 0;
        let dependencyRule: RecordingPolicy['dependencies'][number] | undefined;
        try {
          const url = new URL(
            typeof input === 'string' || input instanceof URL
              ? input.toString()
              : input.url,
          );
          const method =
            init?.method ?? (input instanceof Request ? input.method : 'GET');
          dependencyRule = policy?.dependencies.find(
            (rule) =>
              rule.origin === url.origin &&
              rule.route === url.pathname &&
              rule.method === method.toUpperCase(),
          );
        } catch {
          /* Unknown inputs remain metadata-only. */
        }
        if (state && !state.ended && policy && !dependencyRule) state.truncated = true;
        let unsupportedInputs = false;
        try {
          const url = new URL(
            typeof input === 'string' || input instanceof URL
              ? input.toString()
              : input.url,
          );
          unsupportedInputs = Boolean(
            url.search ||
            init?.body ||
            (input instanceof Request && input.body) ||
            [
              ...new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined),
              ).keys(),
            ].some((key) => !['accept', 'content-type'].includes(key)),
          );
        } catch {
          unsupportedInputs = true;
        }
        let entry: HttpRecording['dependencies'][number] | undefined;
        if (state && !state.ended && dependencyRule) {
          if (state.recordings.length < 20) {
            entry = {
              id: dependencyRule.id,
              origin: dependencyRule.origin,
              method: dependencyRule.method,
              route: dependencyRule.route,
              statusCode: null,
              body: {},
              partial: true,
              result: 'omitted',
            };
            state.recordings.push(entry);
          } else state.truncated = true;
        }
        let outcome: 'success' | 'failure' = 'failure';
        try {
          const response = await implementation(input, init);
          outcome = response.ok ? 'success' : 'failure';
          if (entry && state && dependencyRule) {
            entry.statusCode = response.status;
            entry.result = 'response';
            const selected = entry;
            const pending = responseBody(response, dependencyRule.responseFields)
              .then((body) => {
                if (!state.finished)
                  Object.assign(selected, {
                    ...body,
                    partial:
                      body.partial ||
                      unsupportedInputs ||
                      response.redirected ||
                      (response.status >= 300 && response.status < 400) ||
                      [...response.headers.keys()].some(
                        (key) =>
                          ![
                            'content-type',
                            'content-length',
                            'date',
                            'connection',
                            'keep-alive',
                            'transfer-encoding',
                          ].includes(key) &&
                          !dependencyRule?.ignoredResponseHeaders?.includes(
                            key as 'x-request-id',
                          ),
                      ),
                  });
              })
              .catch(() => {})
              .finally(() => {
                state.pending.delete(pending);
              });
            state.pending.add(pending);
          }
          return response;
        } catch (error) {
          if (entry) entry.result = 'transport-error';
          throw error;
        } finally {
          if (state && !state.ended && state.dependencies.length < 100) {
            state.dependencies.push({
              dependencyId,
              operation,
              outcome,
              offsetMs,
              durationMs: Math.min(
                INCIDENT_LIMITS.durationMs,
                Math.max(0, Math.round(performance.now() - started)),
              ),
            });
          }
        }
      };
    },
    getRequestId(request: ExpressRequest): string | undefined {
      return states.get(request)?.id;
    },
    middleware(request: ExpressRequest, response: ServerResponse, next: Next): void {
      if (states.has(request)) {
        next();
        return;
      }
      const state: RequestState = {
        request,
        postgres: [],
        operations: [],
        id: randomUUID(),
        started: performance.now(),
        captured: false,
        dependencies: [],
        finished: false,
        ended: false,
        recordings: [],
        pending: new Set(),
        truncated: false,
      };
      states.set(request, state);
      if (!response.headersSent) response.setHeader('x-request-id', state.id);
      const report = (aborted: boolean) => {
        if (state.captured) return;
        const contract = state.fixture ? fixtureContract(state.fixture) : undefined;
        const eligible =
          !aborted &&
          response.statusCode >= 500 &&
          contract?.method === request.method &&
          (state.fixture?.runner === 'express-app-v1' ||
            [500, 503].includes(response.statusCode));
        captureException(request, response, state.error, {
          code:
            eligible && contract
              ? contract.code
              : aborted
                ? 'HTTP_REQUEST_ABORTED'
                : `HTTP_${response.statusCode}`,
          ...(eligible && state.fixture ? { replayFixture: state.fixture } : {}),
        });
      };
      const end = () => {
        state.ended = true;
        state.durationMs = Math.min(
          INCIDENT_LIMITS.durationMs,
          Math.max(0, Math.round(performance.now() - state.started)),
        );
      };
      const finish = () => {
        end();
        response.off('close', close);
        if (response.statusCode >= (options.captureClientErrors ? 400 : 500)) {
          if (!state.pending.size) {
            state.finished = true;
            report(false);
          } else {
            const timer = setTimeout(() => {
              state.finished = true;
              report(false);
            }, 250);
            void Promise.allSettled([...state.pending]).then(() => {
              if (state.finished) return;
              clearTimeout(timer);
              state.finished = true;
              report(false);
            });
          }
        } else state.finished = true;
      };
      const close = () => {
        end();
        state.finished = true;
        response.off('finish', finish);
        if (!response.writableFinished) report(true);
      };
      response.once('finish', finish);
      response.once('close', close);
      scope.run(state, next);
    },
    /** Put after routes, before the application's final error responder. */
    errorHandler(
      error: unknown,
      request: ExpressRequest,
      _response: ServerResponse,
      next: Next,
    ): void {
      const state = states.get(request);
      if (state) {
        state.error = error;
        state.errorAt ??= new Date().toISOString();
        state.errorOffsetMs ??= Math.min(
          INCIDENT_LIMITS.durationMs,
          Math.max(0, Math.round(performance.now() - state.started)),
        );
      }
      next(error);
    },
    /** Use a reviewed full template for mounted routers, e.g. /teams/:id/orders. */
    route(template: string) {
      const validated = routeSchema.parse(template);
      return (request: ExpressRequest, _response: ServerResponse, next: Next): void => {
        const state = states.get(request);
        if (state) state.route = validated;
        next();
      };
    },
    /** Apply only after selecting the matching reviewed input case. No body is stored. */
    replay(input: ReplayFixture) {
      const fixture = replayFixtureSchema.parse(input);
      const contract = fixtureContract(fixture);
      return (request: ExpressRequest, _response: ServerResponse, next: Next): void => {
        const state = states.get(request);
        if (state) {
          state.fixture = fixture;
          state.route = contract.route;
        }
        next();
      };
    },
    captureException,
  };
}
