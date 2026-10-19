import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { incidentSchema, stackFrameSchema } from '@timemachine/core';

const optionsSchema = z.strictObject({
  collectorUrl: z.url(),
  sourceEvidenceFiles: z.array(stackFrameSchema.shape.file).max(5).optional(),
  sourceRoot: z.string().max(4096).refine(isAbsolute).optional(),
  token: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[\x21-\x7e]+$/),
  service: incidentSchema.shape.service,
  language: z.enum(['javascript', 'typescript']).default('javascript'),
  allowInsecureHttp: z.boolean().default(false),
  maxQueueSize: z.number().int().min(1).max(1000).default(100),
  maxQueueBytes: z.number().int().min(1024).max(16777216).default(1048576),
  requestTimeoutMs: z.number().int().min(10).max(30000).default(2000),
  maxRetries: z.number().int().min(0).max(3).default(2),
  retryDelayMs: z.number().int().min(1).max(5000).default(250),
});

export type TimeMachineOptions = z.input<typeof optionsSchema>;
export type SdkConfig = Readonly<z.output<typeof optionsSchema>>;

export function parseOptions(input: TimeMachineOptions): SdkConfig {
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid TimeMachine SDK configuration');
  const config = parsed.data;
  const url = new URL(config.collectorUrl);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !loopback && !config.allowInsecureHttp)
  ) {
    throw new Error('Invalid TimeMachine collector URL');
  }
  if (Object.values(config.service).some((value) => value.includes(config.token))) {
    throw new Error('Collector credentials cannot be used as service metadata');
  }
  return Object.freeze({ ...config, collectorUrl: url.href.replace(/\/$/, '') });
}
