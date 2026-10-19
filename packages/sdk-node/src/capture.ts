import { projectFrames } from './frames.js';
import { randomUUID } from 'node:crypto';
import {
  INCIDENT_LIMITS,
  NODE_HTTP_REPLAY_MODE,
  replayFixtureSchema,
  validateReplayBinding,
  parseIncident,
  type Incident,
  type TimelineEvent,
  type Failure,
} from '@timemachine/core';
import type { SdkConfig } from './options.js';
import type { CaptureContext } from './types.js';

function errorName(error: unknown): string {
  // Never read user-defined name, message, stack, cause, or object properties.
  try {
    if (error instanceof TypeError) return 'TypeError';
    if (error instanceof RangeError) return 'RangeError';
    if (error instanceof ReferenceError) return 'ReferenceError';
    if (error instanceof SyntaxError) return 'SyntaxError';
    if (error instanceof URIError) return 'URIError';
    if (error instanceof EvalError) return 'EvalError';
    if (error instanceof AggregateError) return 'AggregateError';
  } catch {
    // A thrown proxy may reject prototype inspection.
  }
  return 'CapturedError';
}

function hasCredential(value: unknown, token: string): boolean {
  if (typeof value === 'string') return value.includes(token);
  if (Array.isArray(value))
    return value.some((item: unknown) => hasCredential(item, token));
  if (value !== null && typeof value === 'object')
    return Object.values(value).some((item: unknown) => hasCredential(item, token));
  return false;
}

export function buildIncident(
  config: SdkConfig,
  error: unknown,
  context: CaptureContext,
  sourceAccess?: Failure['sourceAccess'],
): Incident {
  const timestamp = new Date().toISOString();
  const code = context.code ?? 'APPLICATION_ERROR';
  const offsetMs = context.http?.durationMs ?? 0;
  if (
    !Number.isInteger(offsetMs) ||
    offsetMs < 0 ||
    offsetMs > INCIDENT_LIMITS.durationMs
  ) {
    throw new Error('Invalid HTTP duration');
  }
  const errorOffsetMs = context.http?.errorOffsetMs ?? offsetMs;
  if (!Number.isInteger(errorOffsetMs) || errorOffsetMs < 0 || errorOffsetMs > offsetMs)
    throw new Error('Invalid error offset');
  const requestId = context.requestId ?? randomUUID();
  const timeline: TimelineEvent[] = [];
  if (context.http)
    timeline.push({
      id: 'event-1',
      offsetMs: 0,
      type: 'http.request',
      method: context.http.method,
      route: context.http.route,
    });
  timeline.push({
    id: `event-${timeline.length + 1}`,
    offsetMs: errorOffsetMs,
    type: 'error',
    code,
  });
  if (context.http?.statusCode !== undefined)
    timeline.push({
      id: `event-${timeline.length + 1}`,
      offsetMs,
      type: 'http.response',
      statusCode: context.http.statusCode,
    });
  if (context.dependencies) {
    if (context.dependencies.length > 100) throw new Error('Too many dependencies');
    for (const dependency of context.dependencies)
      timeline.push({ ...dependency, type: 'dependency', id: 'pending' });
    timeline.sort((a, b) => a.offsetMs - b.offsetMs);
    timeline.forEach((event, index) => {
      event.id = `event-${index + 1}`;
    });
  }
  const fixture = context.replayFixture
    ? replayFixtureSchema.parse(context.replayFixture)
    : undefined;
  const id = randomUUID();
  const incident = parseIncident({
    schemaVersion: 1,
    id,
    occurredAt: context.occurredAt ?? timestamp,
    capturedAt: timestamp,
    service: config.service,
    runtime: { language: config.language, name: 'node', version: process.versions.node },
    adapter: {
      name: 'sdk-node',
      version: '0.1.0',
      capabilities: {
        capture: [
          'errors',
          ...(context.http ? ['http-metadata' as const] : []),
          ...(context.dependencies?.length ? ['dependency-metadata' as const] : []),
        ],
        replay: fixture ? [NODE_HTTP_REPLAY_MODE] : [],
      },
    },
    correlation: { requestId, correlationId: context.correlationId ?? requestId },
    failure: {
      source: context.http ? 'http-handler' : 'unhandled-error',
      name: errorName(error),
      code,
      summary: 'Failure captured without raw error details.',
      frames: projectFrames(error, config.sourceRoot),
      ...(sourceAccess ? { sourceAccess } : {}),
    },
    timeline,
    ...(context.recording ? { recording: context.recording } : {}),
    replay: fixture
      ? { status: 'candidate', mode: NODE_HTTP_REPLAY_MODE, fixtureSetId: id }
      : { status: 'unsupported', reason: 'missing-fixtures' },
  });
  if (fixture) validateReplayBinding(incident, fixture);
  if (hasCredential(incident, config.token) || hasCredential(fixture, config.token))
    throw new Error('Sensitive incident metadata');
  return incident;
}
