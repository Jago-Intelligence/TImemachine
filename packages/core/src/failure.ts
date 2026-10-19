import { z } from 'zod';
import { recordingFieldSchema } from './http-recording.js';
import { INCIDENT_LIMITS } from './limits.js';
import { identifierSchema, labelSchema, summarySchema } from './primitives.js';

export const stackFrameSchema = z.strictObject({
  function: labelSchema.optional(),
  file: z
    .string()
    .min(1)
    .max(256)
    .refine((file) => {
      if (/[^A-Za-z0-9_./-]/.test(file)) return false;
      return file
        .split('/')
        .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
    }),
  line: z.number().int().min(1).max(10_000_000),
  column: z.number().int().min(1).max(10_000_000).optional(),
});

export const sourceAccessSchema = z.strictObject({
  file: stackFrameSchema.shape.file,
  line: stackFrameSchema.shape.line,
  column: stackFrameSchema.shape.column,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  field: recordingFieldSchema,
  operation: z.enum(['toFixed', 'trim', 'toLowerCase', 'toUpperCase']),
  receiver: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}(?:\.data)?$/)
    .optional(),
  dependencyId: identifierSchema,
  dependencyType: z.enum(['http', 'postgres']).optional(),
});
export type SourceAccess = z.infer<typeof sourceAccessSchema>;

export const failureSchema = z.strictObject({
  source: z.enum(['http-handler', 'unhandled-error']),
  name: labelSchema,
  code: identifierSchema.optional(),
  summary: summarySchema,
  // Project-relative structured frames, never a raw runtime stack string.
  sourceAccess: sourceAccessSchema.optional(),
  frames: z.array(stackFrameSchema).max(INCIDENT_LIMITS.stackFrames),
});

export type Failure = z.infer<typeof failureSchema>;
