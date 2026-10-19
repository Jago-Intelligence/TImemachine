import { z } from 'zod';
const recordingFieldSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(
    (key) =>
      !/password|passwd|secret|token|authorization|cookie|email|phone|address|session/i.test(
        key,
      ),
  );

/** A deliberately bounded SELECT grammar; validation never executes SQL. */
export function normalizePostgresQuery(input: string): string | undefined {
  const text = input.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!text || text.length > 4096) return;
  const tokens = text.match(
    /\$[1-9][0-9]?|[a-z_][a-z0-9_]*|[0-9]+|<>|!=|<=|>=|[=<>(),.]/g,
  );
  if (!tokens || tokens.join('') !== text.replace(/ /g, '') || tokens.length > 512)
    return;
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = (value: string) => (peek() === value ? (++cursor, true) : false);
  const reserved = new Set(
    'select distinct from as join inner left right full outer cross on where and or not in is null true false order by asc desc nulls first last limit offset for union intersect except into having group with returning update delete insert create drop alter truncate lateral natural'.split(
      ' ',
    ),
  );
  function name(): boolean {
    const value = peek();
    if (!value || !/^[a-z_][a-z0-9_]*$/.test(value) || reserved.has(value)) return false;
    cursor++;
    return true;
  }
  function reference(): boolean {
    if (!name()) return false;
    let parts = 1;
    while (take('.')) {
      if (++parts > 3 || !name()) return false;
    }
    return true;
  }
  function alias(): boolean {
    if (take('as')) return name();
    if (peek() && /^[a-z_]/.test(peek()!) && !reserved.has(peek()!)) return name();
    return true;
  }
  function parameter(): boolean {
    if (!peek() || !/^\$[1-9][0-9]?$/.test(peek()!)) return false;
    cursor++;
    return true;
  }
  function operand(): boolean {
    return parameter() || reference();
  }
  function predicate(depth: number): boolean {
    if (depth > 8) return false;
    if (take('(')) return expression(depth + 1) && take(')');
    if (!reference()) return false;
    if (take('is')) {
      take('not');
      return take('null');
    }
    const negated = take('not');
    if (take('in')) {
      if (!take('(') || !parameter()) return false;
      while (take(',')) if (!parameter()) return false;
      return take(')');
    }
    if (negated || !peek() || !['=', '<>', '!=', '<', '>', '<=', '>='].includes(peek()!))
      return false;
    cursor++;
    return operand();
  }
  function conjunction(depth: number): boolean {
    if (!predicate(depth)) return false;
    while (take('and')) if (!predicate(depth)) return false;
    return true;
  }
  function expression(depth: number): boolean {
    if (!conjunction(depth)) return false;
    while (take('or')) if (!conjunction(depth)) return false;
    return true;
  }
  function count(): boolean {
    if (parameter()) return true;
    if (!peek() || !/^(?:0|[1-9][0-9]{0,5})$/.test(peek()!)) return false;
    cursor++;
    return true;
  }
  if (!take('select')) return;
  take('distinct');
  if (!reference() || !alias()) return;
  while (take(',')) if (!reference() || !alias()) return;
  if (!take('from') || !reference() || !alias()) return;
  let joins = 0;
  while (['join', 'inner', 'left', 'right', 'full'].includes(peek() ?? '')) {
    if (++joins > 8) return;
    if (!take('join')) {
      const kind = peek();
      cursor++;
      if (kind !== 'inner') take('outer');
      if (!take('join')) return;
    }
    if (!reference() || !alias() || !take('on') || !expression(0)) return;
  }
  if (take('where') && !expression(0)) return;
  if (take('order')) {
    if (!take('by')) return;
    do {
      if (!reference()) return;
      if (!take('asc')) take('desc');
      if (take('nulls') && !take('first') && !take('last')) return;
    } while (take(','));
  }
  if (take('limit') && !count()) return;
  if (take('offset') && !count()) return;
  return cursor === tokens.length ? text : undefined;
}
export const postgresScalarSchema = z.union([
  z.string().max(128),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const postgresRecordingSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  parameters: z.array(postgresScalarSchema).max(20),
  rows: z
    .array(
      z
        .record(recordingFieldSchema, postgresScalarSchema)
        .refine((row) => Object.keys(row).length <= 20),
    )
    .max(20),
  fields: z.array(recordingFieldSchema).max(20).optional(),
  rowCount: z.number().int().min(0).max(10000).nullable(),
  result: z.enum(['rows', 'error', 'omitted']),
  errorCode: z
    .string()
    .regex(/^(?:[0-9A-Z]{5}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND)$/)
    .optional(),
  partial: z.boolean(),
});
export type PostgresRecording = z.infer<typeof postgresRecordingSchema>;
