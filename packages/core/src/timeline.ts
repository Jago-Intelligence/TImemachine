import { z } from 'zod';
import {
  httpMethodSchema,
  identifierSchema,
  offsetSchema,
  routeSchema,
} from './primitives.js';

const eventFields = { id: identifierSchema, offsetMs: offsetSchema };

export const timelineEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...eventFields,
    type: z.literal('http.request'),
    method: httpMethodSchema,
    route: routeSchema,
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal('http.response'),
    statusCode: z.number().int().min(100).max(599),
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal('error'),
    code: identifierSchema,
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal('dependency'),
    dependencyId: identifierSchema,
    operation: identifierSchema,
    outcome: z.enum(['success', 'failure']),
    durationMs: offsetSchema,
  }),
]);

export type TimelineEvent = z.infer<typeof timelineEventSchema>;
