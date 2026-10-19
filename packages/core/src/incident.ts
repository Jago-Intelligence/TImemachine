import { httpRecordingSchema } from './http-recording.js';
import { z } from 'zod';
import { adapterSchema, runtimeSchema } from './adapter.js';
import { failureSchema } from './failure.js';
import {
  INCIDENT_LIMITS,
  INCIDENT_SCHEMA_VERSION,
  NODE_HTTP_REPLAY_MODE,
} from './limits.js';
import { identifierSchema, labelSchema, timestampSchema } from './primitives.js';
import { replayEligibilitySchema } from './replay.js';
import { timelineEventSchema } from './timeline.js';

export const incidentSchema = z
  .strictObject({
    schemaVersion: z.literal(INCIDENT_SCHEMA_VERSION),
    id: z.uuid(),
    occurredAt: timestampSchema,
    capturedAt: timestampSchema,
    service: z.strictObject({
      name: identifierSchema,
      version: labelSchema,
      environment: identifierSchema,
    }),
    runtime: runtimeSchema,
    adapter: adapterSchema,
    correlation: z.strictObject({
      requestId: identifierSchema,
      correlationId: identifierSchema,
    }),
    failure: failureSchema,
    recording: httpRecordingSchema.optional(),
    timeline: z.array(timelineEventSchema).min(1).max(INCIDENT_LIMITS.timelineEvents),
    replay: replayEligibilitySchema,
  })
  .superRefine((incident, context) => {
    const invalid = (path: (string | number)[]) => {
      context.addIssue({
        code: 'custom',
        path,
        message: 'Inconsistent incident metadata',
      });
    };
    if (Date.parse(incident.capturedAt) < Date.parse(incident.occurredAt)) {
      invalid(['capturedAt']);
    }

    if (
      incident.recording &&
      !incident.timeline.some(
        (event) =>
          event.type === 'http.request' &&
          event.method === incident.recording!.request.method &&
          event.route === incident.recording!.request.route,
      )
    )
      invalid(['recording']);
    if (
      incident.failure.sourceAccess &&
      !incident.failure.frames.some(
        (frame) =>
          frame.file === incident.failure.sourceAccess!.file &&
          frame.line === incident.failure.sourceAccess!.line &&
          frame.column === incident.failure.sourceAccess!.column,
      )
    )
      invalid(['failure', 'sourceAccess']);
    const ids = new Set<string>();
    let previousOffset = 0;
    for (const [index, event] of incident.timeline.entries()) {
      if (ids.has(event.id)) invalid(['timeline', index, 'id']);
      if (event.offsetMs < previousOffset) invalid(['timeline', index, 'offsetMs']);
      ids.add(event.id);
      previousOffset = event.offsetMs;
      const capability = event.type.startsWith('http.')
        ? 'http-metadata'
        : event.type === 'error'
          ? 'errors'
          : 'dependency-metadata';
      if (!incident.adapter.capabilities.capture.includes(capability)) {
        invalid(['adapter', 'capabilities', 'capture']);
      }
    }

    if (!incident.adapter.capabilities.capture.includes('errors')) {
      invalid(['adapter', 'capabilities', 'capture']);
    }
    const declaresNodeReplay =
      incident.adapter.capabilities.replay.includes(NODE_HTTP_REPLAY_MODE);
    if (declaresNodeReplay) {
      const nodeLanguage = ['javascript', 'typescript'].includes(
        incident.runtime.language,
      );
      if (incident.runtime.name !== 'node' || !nodeLanguage) invalid(['runtime']);
    }
    if (incident.replay.status === 'candidate') {
      if (!declaresNodeReplay) {
        invalid(['adapter', 'capabilities', 'replay']);
      }
      if (
        incident.failure.source !== 'http-handler' ||
        !incident.timeline.some((event) => event.type === 'http.request')
      ) {
        invalid(['replay']);
      }
    }
  });

export type Incident = z.infer<typeof incidentSchema>;
