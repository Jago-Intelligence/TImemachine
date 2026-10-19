import { z } from 'zod';
import { normalizePostgresQuery, postgresScalarSchema } from './postgres-recording.js';
const field = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(
    (key) =>
      !/password|passwd|secret|token|authorization|cookie|email|phone|address|session/i.test(
        key,
      ),
  );
export const operationValuesSchema = z
  .record(field, postgresScalarSchema)
  .refine((value) => Object.keys(value).length <= 20);
export const operationRecordingSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  kind: z.enum(['mysql', 'mongodb', 'bullmq']),
  operation: z.enum(['query', 'execute', 'findOne', 'add']),
  selectorHash: z.string().regex(/^[a-f0-9]{64}$/),
  input: operationValuesSchema,
  inputOrder: z.array(field).max(20).optional(),
  rows: z.array(operationValuesSchema).max(20),
  fields: z.array(field).max(20).optional(),
  partial: z.boolean(),
  result: z.enum(['rows', 'error', 'omitted']),
});
export type OperationRecording = z.infer<typeof operationRecordingSchema>;
export function normalizeMysqlRead(text: string) {
  if (text.includes('$')) return;
  let index = 0;
  const normalized = normalizePostgresQuery(text.replace(/\?/g, () => `$${++index}`));
  return index <= 20 ? normalized : undefined;
}
/** Return a non-sensitive canonical selector; callers hash it before storage. */
export function operationSelector(
  kind: OperationRecording['kind'],
  operation: OperationRecording['operation'],
  selector: string,
) {
  if (kind === 'mysql' && ['query', 'execute'].includes(operation))
    return normalizeMysqlRead(selector);
  if (
    ((kind === 'mongodb' && operation === 'findOne') ||
      (kind === 'bullmq' && operation === 'add')) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(selector)
  )
    return selector;
  return undefined;
}
export const operationRuleSchema = z
  .strictObject({
    id: operationRecordingSchema.shape.id,
    kind: operationRecordingSchema.shape.kind,
    operation: operationRecordingSchema.shape.operation,
    selector: z.string().min(1).max(4096),
    inputFields: z
      .array(field)
      .max(20)
      .refine((keys) => new Set(keys).size === keys.length),
    resultFields: z
      .array(field)
      .max(20)
      .refine((keys) => new Set(keys).size === keys.length),
  })
  .refine(
    (rule) => operationSelector(rule.kind, rule.operation, rule.selector) !== undefined,
  );
export type OperationRule = z.infer<typeof operationRuleSchema>;
