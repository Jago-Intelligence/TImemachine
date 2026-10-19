import { createHash } from 'node:crypto';
import { z } from 'zod';
import { incidentSchema, type Incident, type ReplayRun } from '@timemachine/core';
import { IncidentStoreError } from './store.js';
import { incidentPage, validateListOptions, type IncidentPage } from './list.js';

export const issueIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const serviceSchema = incidentSchema.shape.service.shape.name;
const position = z.strictObject({
  lastSeen: z.iso.datetime({ precision: 3 }),
  id: issueIdSchema,
});
const optionsSchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
  service: serviceSchema.optional(),
  allowedServices: z.array(serviceSchema).max(50).optional(),
  q: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) =>
      Array.from(value).every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
      ),
    )
    .optional(),
  status: z.enum(['open', 'resolved']).optional(),
  from: z.iso.datetime({ precision: 3 }).optional(),
  to: z.iso.datetime({ precision: 3 }).optional(),
  after: position.optional(),
});
export type IssueListOptions = z.infer<typeof optionsSchema>;
export const resolveIssueSchema = z.strictObject({
  incidentId: z.uuid(),
  runId: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ResolveIssueInput = z.infer<typeof resolveIssueSchema>;
export const issueLifecycleSchema = z.strictObject({
  status: z.enum(['open', 'resolved']).default('open'),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  resolution: z
    .strictObject({
      resolvedAt: z.iso.datetime({ precision: 3 }),
      incidentId: z.uuid(),
      runId: z.uuid(),
      artifactId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .nullable()
    .default(null),
});
export type IssueLifecycle = z.infer<typeof issueLifecycleSchema>;
export function verifiedResolution(
  run: ReplayRun | undefined,
  input: ResolveIssueInput,
  revision: number,
) {
  if (!run) throw new IncidentStoreError('VERIFICATION_REQUIRED');
  if (input.revision !== revision || run?.issueRevision !== revision)
    throw new IncidentStoreError('ISSUE_CHANGED');
  if (
    !run ||
    run.id !== input.runId ||
    run.incidentId !== input.incidentId ||
    run.mode !== 'current' ||
    run.verification !== 'matched' ||
    !run.target?.outcome ||
    !run.actual?.outcome ||
    !run.finishedAt ||
    ['running', 'failed'].includes(run.status) ||
    (run.actual.checks ?? []).some((check) => check.status === 'failed')
  )
    throw new IncidentStoreError('VERIFICATION_REQUIRED');
  return {
    resolvedAt: new Date().toISOString(),
    incidentId: run.incidentId,
    runId: run.id,
    artifactId: run.artifactId,
  };
}
export const issueSummarySchema = z.strictObject({
  ...issueLifecycleSchema.shape,
  id: issueIdSchema,
  occurrences: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  firstSeen: z.iso.datetime({ precision: 3 }),
  lastSeen: z.iso.datetime({ precision: 3 }),
  latestIncidentId: z.uuid(),
  service: incidentSchema.shape.service,
  failure: incidentSchema.shape.failure.pick({ name: true, code: true }),
  http: z
    .strictObject({ method: z.string().max(16), route: z.string().max(256) })
    .nullable(),
});
export type IssueSummary = z.infer<typeof issueSummarySchema>;
export interface IssuePage {
  items: IssueSummary[];
  nextCursor: string | null;
}
export interface IssueDetail {
  issue: IssueSummary;
  occurrences: IncidentPage;
}

/** Identity v1 excludes dynamic request IDs, times, durations and release versions. */
export function issueId(incident: Incident): string {
  const request = incident.timeline.find((event) => event.type === 'http.request');
  const frame = incident.failure.frames[0];
  const fields = [
    'v1',
    incident.service.name,
    incident.service.environment,
    request?.method ?? '',
    request?.route ?? '',
    incident.failure.code ?? '',
    incident.failure.name,
    incident.failure.source,
    frame?.file ?? '',
    frame ? String(frame.line) : '',
  ];
  return createHash('sha256')
    .update(
      fields.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|'),
    )
    .digest('hex');
}
export function summarizeIssue(
  latest: Incident,
  occurrences: number,
  firstSeen: string,
  lastSeen: string,
): IssueSummary {
  const request = latest.timeline.find((event) => event.type === 'http.request');
  return issueSummarySchema.parse({
    id: issueId(latest),
    occurrences,
    firstSeen,
    lastSeen,
    latestIncidentId: latest.id,
    service: latest.service,
    failure: {
      name: latest.failure.name,
      ...(latest.failure.code ? { code: latest.failure.code } : {}),
    },
    http: request ? { method: request.method, route: request.route } : null,
  });
}
export function validateIssueOptions(input: IssueListOptions): IssueListOptions {
  const parsed = optionsSchema.parse(input);
  if (parsed.from && parsed.to && parsed.from >= parsed.to)
    throw new Error('Invalid date range');
  return parsed;
}
export function parseIssueListQuery(query: unknown): IssueListOptions {
  const input = z
    .strictObject({
      limit: z
        .string()
        .regex(/^[1-9][0-9]{0,2}$/)
        .optional(),
      ...optionsSchema.pick({
        service: true,
        q: true,
        status: true,
        from: true,
        to: true,
      }).shape,
      cursor: z
        .string()
        .max(1024)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
    })
    .parse(query);
  let after: IssueListOptions['after'];
  if (input.cursor) {
    const decoded = z
      .strictObject({
        v: z.literal(1),
        kind: z.literal('issues'),
        service: serviceSchema.nullable(),
        filters: z.string().max(1024).optional(),
        position,
      })
      .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
    if (
      decoded.service !== (input.service ?? null) ||
      (decoded.filters ??
        filterKey({ ...(input.service ? { service: input.service } : {}) })) !==
        filterKey(input)
    )
      throw new Error('Cursor filter mismatch');
    after = decoded.position;
  }
  return validateIssueOptions({
    limit: input.limit ? Number(input.limit) : 25,
    ...(input.service ? { service: input.service } : {}),
    ...(input.q ? { q: input.q } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(after ? { after } : {}),
  });
}
function filterKey(
  options: Pick<IssueListOptions, 'service' | 'q' | 'status' | 'from' | 'to'>,
) {
  return JSON.stringify([
    options.service ?? null,
    options.q ?? null,
    options.status ?? null,
    options.from ?? null,
    options.to ?? null,
  ]);
}
export function issuePage(rows: IssueSummary[], options: IssueListOptions): IssuePage {
  const items = rows.slice(0, options.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > options.limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              kind: 'issues',
              filters: filterKey(options),
              service: options.service ?? null,
              position: { id: last.id, lastSeen: last.lastSeen },
            }),
          ).toString('base64url')
        : null,
  };
}
export function memoryIssues(
  incidents: Incident[],
  input: IssueListOptions,
  states?: ReadonlyMap<string, IssueLifecycle>,
): IssuePage {
  const options = validateIssueOptions(input);
  const groups = new Map<string, Incident[]>();
  for (const incident of incidents) {
    if (options.service && incident.service.name !== options.service) continue;
    if (
      options.allowedServices &&
      !options.allowedServices.includes(incident.service.name)
    )
      continue;
    const id = issueId(incident);
    const group = groups.get(id) ?? [];
    group.push(incident);
    groups.set(id, group);
  }
  const rows = [...groups.values()]
    .map((group) => {
      group.sort(
        (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id),
      );
      return {
        ...summarizeIssue(
          group[0]!,
          group.length,
          group.at(-1)!.occurredAt,
          group[0]!.occurredAt,
        ),
        ...structuredClone(states?.get(issueId(group[0]!))),
      };
    })
    .filter(
      (row) =>
        (!options.status || row.status === options.status) &&
        (!options.from || row.lastSeen >= options.from) &&
        (!options.to || row.lastSeen < options.to) &&
        (!options.q ||
          [
            row.id,
            row.service.name,
            row.service.environment,
            row.failure.name,
            row.failure.code ?? '',
            row.http?.method ?? '',
            row.http?.route ?? '',
          ]
            .join(' ')
            .toLowerCase()
            .includes(options.q.toLowerCase())),
    )
    .filter(
      (row) =>
        !options.after ||
        row.lastSeen < options.after.lastSeen ||
        (row.lastSeen === options.after.lastSeen && row.id < options.after.id),
    )
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.id.localeCompare(a.id));
  return issuePage(rows, options);
}
export function memoryIssueDetail(
  incidents: Incident[],
  id: string,
  options: import('./list.js').IncidentListOptions,
): IssueDetail | undefined {
  issueIdSchema.parse(id);
  const all = incidents
    .filter((incident) => issueId(incident) === id)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
  if (!all.length) return undefined;
  const selected = all.filter(
    (row) =>
      !options.after ||
      row.occurredAt < options.after.occurredAt ||
      (row.occurredAt === options.after.occurredAt && row.id < options.after.id),
  );
  return {
    issue: summarizeIssue(
      all[0]!,
      all.length,
      all.at(-1)!.occurredAt,
      all[0]!.occurredAt,
    ),
    occurrences: occurrencePage(selected, options, id),
  };
}

export function parseIssueOccurrenceQuery(
  query: unknown,
  id: string,
): import('./list.js').IncidentListOptions {
  issueIdSchema.parse(id);
  const input = z
    .strictObject({
      limit: z
        .string()
        .regex(/^[1-9][0-9]{0,2}$/)
        .optional(),
      cursor: z
        .string()
        .max(1024)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
    })
    .parse(query);
  let after: import('./list.js').IncidentListOptions['after'];
  if (input.cursor) {
    const decoded = z
      .strictObject({
        v: z.literal(1),
        kind: z.literal('occurrences'),
        issueId: issueIdSchema,
        position: z.strictObject({
          occurredAt: z.iso.datetime({ precision: 3 }),
          id: z.uuid(),
        }),
      })
      .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
    if (decoded.issueId !== id) throw new Error('Cursor issue mismatch');
    after = decoded.position;
  }
  return validateListOptions({
    limit: input.limit ? Number(input.limit) : 25,
    ...(after ? { after } : {}),
  });
}
export function occurrencePage(
  rows: Incident[],
  options: import('./list.js').IncidentListOptions,
  id: string,
): IncidentPage {
  const page = incidentPage(rows, options);
  const last = page.items.at(-1);
  if (page.nextCursor && last)
    page.nextCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        kind: 'occurrences',
        issueId: id,
        position: { occurredAt: last.occurredAt, id: last.id },
      }),
    ).toString('base64url');
  return page;
}
