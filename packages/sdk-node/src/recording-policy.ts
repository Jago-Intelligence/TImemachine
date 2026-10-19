import { z } from 'zod';
import {
  operationRuleSchema,
  normalizePostgresQuery,
  stackFrameSchema,
  httpRecordingSchema,
  recordingFieldSchema,
  type HttpRecording,
} from '@timemachine/core';

const method = httpRecordingSchema.shape.request.shape.method;
const route = httpRecordingSchema.shape.request.shape.route;
const id = httpRecordingSchema.shape.policyId;
const fields = z.array(recordingFieldSchema).max(20);
export const recordingPolicySchema = z.strictObject({
  id,
  sourceEvidenceFiles: z.array(stackFrameSchema.shape.file).max(5).optional(),
  artifactId: httpRecordingSchema.shape.artifactId,
  ignoredRequestHeaders: z
    .array(
      z.enum([
        'origin',
        'referer',
        'accept-language',
        'priority',
        'dnt',
        'sec-fetch-site',
        'sec-fetch-mode',
        'sec-fetch-dest',
        'sec-ch-ua',
        'sec-ch-ua-mobile',
        'sec-ch-ua-platform',
        'sec-gpc',
      ]),
    )
    .max(16)
    .optional(),
  requests: z
    .array(
      z.strictObject({
        method,
        route,
        bodyFields: fields,
        databaseMode: z.literal('synthetic-postgres').optional(),
      }),
    )
    .max(50),
  operations: z.array(operationRuleSchema).max(30).optional(),
  postgres: z
    .array(
      z.strictObject({
        id,
        text: z
          .string()
          .max(4096)
          .refine((value) => normalizePostgresQuery(value) !== undefined),
        parameterFields: fields,
        rowFields: fields,
      }),
    )
    .max(20)
    .optional(),
  dependencies: z
    .array(
      z.strictObject({
        id,
        method,
        origin: z.url().refine((value) => {
          const url = new URL(value);
          return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
        }),
        route,
        responseFields: fields,
        ignoredResponseHeaders: z.array(z.literal('x-request-id')).max(1).optional(),
      }),
    )
    .max(50),
});
export type RecordingPolicy = z.infer<typeof recordingPolicySchema>;
type SafeBody = HttpRecording['request']['body'];

export function projectBody(
  input: unknown,
  allowed: string[],
): { body: SafeBody; partial: boolean } {
  const body: SafeBody = {};
  if (input === undefined || input === null) return { body, partial: false };
  if (typeof input !== 'object' || Array.isArray(input)) return { body, partial: true };
  let partial = false;
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input)))
      return { body, partial: true };
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!allowed.includes(key) || !('value' in descriptor)) {
        partial = true;
        continue;
      }
      const value = descriptor.value;
      if (
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= 128)
      )
        body[key] = value;
      else partial = true;
    }
  } catch {
    return { body: {}, partial: true };
  }
  return { body, partial };
}

/** Read a bounded clone, never consume the application's original response. */
export async function responseBody(response: Response, allowed: string[]) {
  if (!allowed.length) return { body: {}, partial: true };
  const clone = response.clone();
  if (!clone.body) return { body: {}, partial: false };
  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 200);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 8192) return { body: {}, partial: true };
      chunks.push(next.value);
    }
    if (timedOut) return { body: {}, partial: true };
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return { body: {}, partial: false };
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return { body: {}, partial: true };
    return projectBody(parsed, allowed);
  } catch {
    return { body: {}, partial: true };
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
