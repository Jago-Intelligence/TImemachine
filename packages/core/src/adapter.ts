import { z } from 'zod';
import { identifierSchema, labelSchema } from './primitives.js';
import { NODE_HTTP_REPLAY_MODE } from './limits.js';

export const adapterCapabilitiesSchema = z.strictObject({
  capture: z
    .array(z.enum(['http-metadata', 'errors', 'dependency-metadata']))
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length),
  replay: z.array(z.literal(NODE_HTTP_REPLAY_MODE)).max(1),
});

/** Describes a producer, rather than prescribing a language-specific SDK interface. */
export const adapterSchema = z.strictObject({
  name: identifierSchema,
  version: labelSchema,
  capabilities: adapterCapabilitiesSchema,
});

export const runtimeSchema = z.strictObject({
  language: identifierSchema,
  name: identifierSchema,
  version: labelSchema,
});

export type AdapterCapabilities = z.infer<typeof adapterCapabilitiesSchema>;
export type AdapterDescriptor = z.infer<typeof adapterSchema>;
export type RuntimeDescriptor = z.infer<typeof runtimeSchema>;
