import { z } from 'zod';
import { NODE_HTTP_REPLAY_MODE } from './limits.js';
import { identifierSchema } from './primitives.js';

export const replayEligibilitySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('unsupported'),
    reason: z.enum([
      'adapter-unsupported',
      'missing-fixtures',
      'uncontrolled-nondeterminism',
      'external-side-effects',
      'capture-incomplete',
    ]),
  }),
  z.strictObject({
    status: z.literal('candidate'),
    mode: z.literal(NODE_HTTP_REPLAY_MODE),
    fixtureSetId: identifierSchema,
  }),
]);

export type ReplayEligibility = z.infer<typeof replayEligibilitySchema>;
