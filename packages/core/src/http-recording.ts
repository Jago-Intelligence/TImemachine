import { operationRecordingSchema } from './operation-recording.js';
import { postgresRecordingSchema } from './postgres-recording.js';
import { z } from 'zod';
import { httpMethodSchema, identifierSchema, routeSchema } from './primitives.js';

export const recordingFieldSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(
    (key) =>
      !/password|passwd|secret|token|authorization|cookie|email|phone|address|session/i.test(
        key,
      ),
  );
const body = z
  .record(
    recordingFieldSchema,
    z.union([z.string().max(128), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 20);
export const httpRecordingSchema = z.strictObject({
  version: z.literal(1),
  databaseMode: z.literal('synthetic-postgres').optional(),
  policyId: identifierSchema,
  artifactId: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  request: z.strictObject({
    method: httpMethodSchema,
    route: routeSchema,
    body,
    partial: z.boolean(),
  }),
  dependencies: z
    .array(
      z.strictObject({
        id: identifierSchema,
        origin: z
          .url()
          .refine((value) => {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && value === url.origin;
          })
          .optional(),
        method: httpMethodSchema,
        route: routeSchema,
        statusCode: z.number().int().min(100).max(599).nullable(),
        body,
        partial: z.boolean(),
        result: z.enum(['response', 'transport-error', 'omitted']),
      }),
    )
    .max(20),
  operations: z.array(operationRecordingSchema).max(20).optional(),
  postgres: z.array(postgresRecordingSchema).max(10).optional(),
  truncated: z.boolean(),
});
export type HttpRecording = z.infer<typeof httpRecordingSchema>;
