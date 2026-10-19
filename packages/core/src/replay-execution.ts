import { httpRecordingSchema } from './http-recording.js';
import { z } from 'zod';
import type { Incident } from './incident.js';
import { identifierSchema, httpMethodSchema, routeSchema } from './primitives.js';
import { timelineEventSchema } from './timeline.js';
const artifact = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const replayExpectationSchema = z.strictObject({
  statusCode: z.number().int().min(100).max(599),
  errorCode: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .nullable(),
  outcome: z.enum(['authenticated-test-user', 'scenario-assertions-passed']).optional(),
  retryAfterSeconds: z.number().int().min(0).max(300).optional(),
});
export type ReplayExpectation = z.infer<typeof replayExpectationSchema>;
const demoFixtureSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runner: z.literal('express-orders-v1'),
    artifactId: artifact,
    profile: z.enum([
      'orders-create-v1',
      'orders-read-v1',
      'orders-update-v1',
      'orders-delete-v1',
      'orders-list-v1',
      'auth-case-normalization-v1',
    ]),
    quantity: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((value, context) => {
    const required = ['orders-create-v1', 'orders-update-v1'].includes(value.profile);
    if (required !== (value.quantity !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'Invalid profile input',
      });
  });
export const expressReplayContractSchema = z
  .strictObject({
    inputMode: z.enum(['recorded-http', 'synthetic-postgres']).optional(),
    databaseFixtureHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    service: identifierSchema,
    profile: identifierSchema,
    scenarioVersion: identifierSchema,
    method: httpMethodSchema.refine(
      (method) => !['CONNECT', 'TRACE'].includes(method),
      'This replay adapter uses fetch-compatible HTTP methods',
    ),
    route: routeSchema,
    failureCode: identifierSchema,
    target: replayExpectationSchema,
  })
  .superRefine((value, context) => {
    if (
      (value.inputMode === 'synthetic-postgres') !==
      (value.databaseFixtureHash !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Synthetic PostgreSQL requires a fixture hash',
      });
    if (value.target.outcome !== 'scenario-assertions-passed')
      context.addIssue({
        code: 'custom',
        message: 'Custom replay must require scenario assertions',
      });
  });
export type ExpressReplayContract = z.infer<typeof expressReplayContractSchema>;
const appFixtureSchema = z
  .strictObject({
    ...expressReplayContractSchema.shape,
    schemaVersion: z.literal(1),
    runner: z.literal('express-app-v1'),
    artifactId: artifact,
    contractHash: z.string().regex(/^[a-f0-9]{64}$/),
    quantity: z.never().optional(),
    recording: httpRecordingSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.recording &&
      (!['recorded-http', 'synthetic-postgres'].includes(value.inputMode ?? '') ||
        (value.inputMode === 'synthetic-postgres') !==
          (value.recording.databaseMode === 'synthetic-postgres') ||
        value.recording.request.method !== value.method ||
        value.recording.request.route !== value.route)
    )
      context.addIssue({ code: 'custom', message: 'Recording does not match contract' });
    if (
      (value.inputMode === 'synthetic-postgres') !==
      (value.databaseFixtureHash !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Synthetic PostgreSQL requires a fixture hash',
      });
    if (value.target.outcome !== 'scenario-assertions-passed')
      context.addIssue({
        code: 'custom',
        message: 'Custom replay must require scenario assertions',
      });
  });
export const replayFixtureSchema = z.discriminatedUnion('runner', [
  demoFixtureSchema,
  appFixtureSchema,
]);
export const replayBackupSchema = z.strictObject({
  artifactId: artifact,
  reference: z
    .string()
    .max(512)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*\/[a-z0-9][a-z0-9._\x2f-]*@sha256:[a-f0-9]{64}$/),
});
export const replayAppRegistrySchema = z
  .strictObject({
    apps: z
      .array(
        z.strictObject({
          service: identifierSchema,
          currentArtifactId: artifact,
          artifacts: z.array(artifact).min(1).max(1000),
          backups: z.array(replayBackupSchema).max(1000).optional(),
          fixtures: z.array(appFixtureSchema).min(1).max(20),
        }),
      )
      .max(10),
  })
  .superRefine((registry, context) => {
    if (new Set(registry.apps.map((app) => app.service)).size !== registry.apps.length)
      context.addIssue({ code: 'custom', message: 'Duplicate replay app' });
    for (const app of registry.apps) {
      if (
        (app.backups?.some((backup) => !app.artifacts.includes(backup.artifactId)) ??
          false) ||
        new Set(app.backups?.map((backup) => backup.artifactId)).size !==
          (app.backups?.length ?? 0) ||
        !app.artifacts.includes(app.currentArtifactId) ||
        new Set(app.fixtures.map((f) => f.profile)).size !== app.fixtures.length ||
        app.fixtures.some(
          (f) => f.service !== app.service || f.artifactId !== app.currentArtifactId,
        )
      )
        context.addIssue({ code: 'custom', message: 'Invalid replay app registration' });
    }
  });
export type ReplayAppRegistry = z.infer<typeof replayAppRegistrySchema>;
export type ReplayFixture = z.infer<typeof replayFixtureSchema>;
export function fixtureContract(fixture: ReplayFixture) {
  if (fixture.runner === 'express-app-v1')
    return { method: fixture.method, route: fixture.route, code: fixture.failureCode };
  const profiles = {
    'orders-create-v1': {
      method: 'POST',
      route: '/orders',
      code: 'ORDER_CREATION_FAILED',
    },
    'orders-read-v1': {
      method: 'GET',
      route: '/orders/:id',
      code: 'ORDER_LOOKUP_FAILED',
    },
    'orders-update-v1': {
      method: 'PATCH',
      route: '/orders/:id',
      code: 'ORDER_UPDATE_FAILED',
    },
    'orders-delete-v1': {
      method: 'DELETE',
      route: '/orders/:id',
      code: 'ORDER_DELETE_FAILED',
    },
    'orders-list-v1': { method: 'GET', route: '/orders', code: 'ORDER_LIST_FAILED' },
    'auth-case-normalization-v1': {
      method: 'POST',
      route: '/auth/login',
      code: 'AUTH_LOGIN_FAILED',
    },
  } as const;
  return profiles[fixture.profile];
}
export function validateReplayBinding(incident: Incident, input: unknown): ReplayFixture {
  const fixture = replayFixtureSchema.parse(input);
  const contract = fixtureContract(fixture);
  const response = incident.timeline.findLast((event) => event.type === 'http.response');
  if (
    incident.replay.status !== 'candidate' ||
    incident.replay.fixtureSetId !== incident.id ||
    incident.service.name !==
      (fixture.runner === 'express-app-v1' ? fixture.service : 'express-orders') ||
    (fixture.runner !== 'express-app-v1' && incident.service.version !== '0.1.0') ||
    incident.runtime.name !== 'node' ||
    incident.adapter.name !== 'sdk-node' ||
    incident.failure.code !== contract.code ||
    !incident.timeline.some(
      (event) =>
        event.type === 'http.request' &&
        event.method === contract.method &&
        event.route === contract.route,
    ) ||
    !response ||
    response.type !== 'http.response' ||
    (fixture.runner === 'express-app-v1'
      ? response.statusCode < 500
      : ![500, 503].includes(response.statusCode))
  )
    throw new Error('Replay fixture does not match incident');
  return fixture;
}
export const replayRequestSchema = z
  .strictObject({
    mode: z.enum(['captured', 'current']).default('captured'),
    target: replayExpectationSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.target && value.mode !== 'current')
      context.addIssue({
        code: 'custom',
        message: 'Verification requires the current build',
      });
  });
export const replayCheckSchema = z.strictObject({
  id: z.enum([
    'response-status',
    'error-code',
    'business-assertions',
    'database-rollback',
    'database-commit',
  ]),
  status: z.enum(['passed', 'failed', 'not-checked']),
});
export type ReplayCheck = z.infer<typeof replayCheckSchema>;
export const replayObservationSchema = z.strictObject({
  statusCode: z.number().int().min(100).max(599),
  errorCode: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .nullable(),
  outcome: z.enum(['authenticated-test-user', 'scenario-assertions-passed']).optional(),
  retryAfterSeconds: z.number().int().min(0).max(300).optional(),
  responseHint: z.literal('temporary-unavailable').optional(),
  checks: z
    .array(replayCheckSchema)
    .max(5)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length)
    .optional(),
  runtimeVersion: z.string().min(1).max(128),
  timeline: z.array(timelineEventSchema).min(1).max(20),
});
export type ReplayObservation = z.infer<typeof replayObservationSchema>;
export const replayRunSchema = z
  .strictObject({
    id: z.uuid(),
    incidentId: z.uuid(),
    artifactId: artifact,
    mode: z.enum(['captured', 'current']),
    issueRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    startedAt: z.iso.datetime({ precision: 3 }),
    finishedAt: z.iso.datetime({ precision: 3 }).optional(),
    status: z.enum(['running', 'reproduced', 'not-reproduced', 'failed']),
    expected: replayExpectationSchema,
    target: replayExpectationSchema.optional(),
    verification: z.enum(['matched', 'not-matched']).optional(),
    actual: replayObservationSchema.optional(),
    errorCode: z
      .enum(['RUNNER_UNAVAILABLE', 'RUN_TIMEOUT', 'INVALID_OUTPUT', 'INTERRUPTED'])
      .optional(),
  })
  .superRefine((run, context) => {
    if (run.target && run.mode !== 'current')
      context.addIssue({
        code: 'custom',
        message: 'Verification requires current build',
      });
    if (
      run.verification &&
      (!run.target ||
        !run.actual ||
        run.status === 'failed' ||
        run.status === 'running' ||
        run.verification !==
          (matchesReplayExpectation(run.actual, run.target) ? 'matched' : 'not-matched'))
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid verification result' });
    }
  });

export type ReplayRun = z.infer<typeof replayRunSchema>;
export const captureEnvelopeSchema = z.strictObject({
  captureVersion: z.literal(1),
  incident: z.unknown(),
  replayFixture: replayFixtureSchema,
});

export function matchesReplayExpectation(
  actual: ReplayObservation,
  target: ReplayExpectation,
): boolean {
  return (
    actual.statusCode === target.statusCode &&
    actual.errorCode === target.errorCode &&
    (target.outcome === undefined || actual.outcome === target.outcome) &&
    (target.retryAfterSeconds === undefined ||
      actual.retryAfterSeconds === target.retryAfterSeconds)
  );
}
