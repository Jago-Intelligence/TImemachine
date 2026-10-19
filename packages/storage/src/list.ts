import { z } from 'zod';
import type { Incident } from '@timemachine/core';

const positionSchema = z.strictObject({
  occurredAt: z.iso.datetime({ precision: 3 }),
  id: z.uuid().transform((id) => id.toLowerCase()),
});
const serviceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const optionsSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  service: serviceSchema.optional(),
  allowedServices: z.array(serviceSchema).max(50).optional(),
  after: positionSchema.optional(),
});
export type IncidentListOptions = z.infer<typeof optionsSchema>;
export interface IncidentSummary {
  id: string;
  occurredAt: string;
  service: Incident['service'];
  failure: Pick<Incident['failure'], 'name' | 'code'>;
  replayStatus: Incident['replay']['status'];
}
export interface IncidentPage {
  items: IncidentSummary[];
  nextCursor: string | null;
}
export function validateListOptions(input: IncidentListOptions): IncidentListOptions {
  return optionsSchema.parse(input);
}
export function parseIncidentListQuery(query: unknown): IncidentListOptions {
  const input = z
    .strictObject({
      limit: z
        .string()
        .regex(/^[1-9][0-9]{0,2}$/)
        .optional(),
      service: serviceSchema.optional(),
      cursor: z
        .string()
        .min(1)
        .max(1024)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
    })
    .parse(query);
  let after: IncidentListOptions['after'];
  if (input.cursor) {
    const decoded = z
      .strictObject({
        v: z.literal(1),
        service: serviceSchema.nullable(),
        position: positionSchema,
      })
      .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
    if (decoded.service !== (input.service ?? null))
      throw new Error('Cursor filter mismatch');
    after = decoded.position;
  }
  return validateListOptions({
    limit: input.limit ? Number(input.limit) : 25,
    ...(input.service ? { service: input.service } : {}),
    ...(after ? { after } : {}),
  });
}
export function incidentPage(
  rows: Incident[],
  options: IncidentListOptions,
): IncidentPage {
  const selected = rows.slice(0, options.limit);
  const last = selected.at(-1);
  return {
    items: selected.map(({ id, occurredAt, service, failure, replay }) => ({
      id,
      occurredAt,
      service,
      failure: { name: failure.name, code: failure.code },
      replayStatus: replay.status,
    })),
    nextCursor:
      rows.length > options.limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              service: options.service ?? null,
              position: { occurredAt: last.occurredAt, id: last.id },
            }),
          ).toString('base64url')
        : null,
  };
}
