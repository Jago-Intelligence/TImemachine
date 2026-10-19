import 'server-only';
import { z } from 'zod';
import { parseIncident, incidentSchema, type ReplayExpectation } from '@timemachine/core';
import { requireSession } from './auth';
const summary = z.strictObject({
  id: z.uuid(),
  occurredAt: z.iso.datetime({ precision: 3 }),
  service: z.strictObject({
    name: z.string().max(128),
    version: z.string().max(128),
    environment: z.string().max(128),
  }),
  failure: z.strictObject({
    name: z.string().max(128),
    code: z.string().max(128).optional(),
  }),
  replayStatus: z.enum(['candidate', 'unsupported']),
});
const pageSchema = z.strictObject({
  apiVersion: z.literal(1),
  items: z.array(summary).max(100),
  nextCursor: z.string().max(1024).nullable(),
});
export type IncidentPage = z.infer<typeof pageSchema>;
export class CollectorUnavailable extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined = undefined,
  ) {
    super('Collector unavailable');
  }
}
function authHeaders(config: Awaited<ReturnType<typeof requireSession>>) {
  if (config.WORKSPACE_AUTH_MODE === 'accounts' && !config.activeProject)
    throw new CollectorUnavailable(403);
  return {
    authorization: `Bearer ${config.TIMEMACHINE_AUTH_TOKEN}`,
    ...(config.activeProject ? { 'x-timemachine-project': config.activeProject.id } : {}),
  };
}
async function request(path: string) {
  const config = await requireSession();
  let response: Response;
  try {
    response = await fetch(`${config.collector}${path}`, {
      headers: authHeaders(config),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (error instanceof CollectorUnavailable) throw error;
    throw new CollectorUnavailable(503);
  }
  if (!response.ok) throw new CollectorUnavailable(response.status);
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof CollectorUnavailable) throw error;
    throw new CollectorUnavailable(503);
  }
}
export async function listIncidents(
  service?: string,
  cursor?: string,
): Promise<IncidentPage> {
  const query = new URLSearchParams({ limit: '25' });
  if (service) query.set('service', service);
  if (cursor) query.set('cursor', cursor);
  const body = await request(`/v1/incidents?${query}`);
  const parsed = pageSchema.safeParse(body);
  if (!parsed.success) throw new CollectorUnavailable(503);
  return parsed.data;
}
export async function getIncident(id: string) {
  const body = await request(`/v1/incidents/${encodeURIComponent(id)}`);
  const envelope = z
    .object({ apiVersion: z.literal(1), incident: z.unknown() })
    .safeParse(body);
  if (!envelope.success) throw new CollectorUnavailable(503);
  try {
    return parseIncident(envelope.data.incident);
  } catch (error) {
    if (error instanceof CollectorUnavailable) throw error;
    throw new CollectorUnavailable(503);
  }
}

const lifecycleSchema = z.object({
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
export async function getReplayInfo(
  id: string,
): Promise<import('./replay-types').ReplayInfo> {
  const { replayFixtureSchema, replayRunSchema } = await import('@timemachine/core');
  const body = await request(`/v1/incidents/${encodeURIComponent(id)}/replays`);
  const parsed = z
    .strictObject({
      apiVersion: z.literal(1),
      issue: lifecycleSchema
        .extend({ id: z.string().regex(/^[a-f0-9]{64}$/) })
        .optional(),
      backup: z.enum(['backed-up', 'not-backed-up']).optional(),
      available: z.boolean(),
      reason: z
        .enum([
          'recording-incomplete',
          'recording-route-unsupported',
          'missing-fixture',
          'runner-disabled',
          'artifact-unavailable',
          'image-restoring',
          'image-recovery-failed',
          'image-missing',
          'docker-unavailable',
          'app-unregistered',
        ])
        .nullable(),
      fixture: replayFixtureSchema.optional(),
      runs: z.array(replayRunSchema).max(20),
    })
    .safeParse(body);
  if (!parsed.success) throw new CollectorUnavailable(503);
  return parsed.data;
}
export async function startReplay(
  id: string,
  mode: 'captured' | 'current',
  target?: ReplayExpectation,
) {
  const config = await requireSession();
  let response: Response;
  try {
    response = await fetch(
      `${config.collector}/v1/incidents/${encodeURIComponent(id)}/replays`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(config),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mode, ...(target ? { target } : {}) }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(35000),
      },
    );
  } catch (error) {
    if (error instanceof CollectorUnavailable) throw error;
    throw new CollectorUnavailable(503);
  }
  if (!response.ok) {
    let code: string | undefined;
    try {
      const failure = (await response.json()) as { error?: { code?: string } };
      if (failure.error?.code === 'REPLAY_SCENARIO_CHANGED') code = failure.error.code;
    } catch {
      /* Return only the safe status below. */
    }
    throw new CollectorUnavailable(response.status, code);
  }
  const { replayRunSchema } = await import('@timemachine/core');
  try {
    return z
      .strictObject({ apiVersion: z.literal(1), run: replayRunSchema })
      .parse(await response.json());
  } catch (error) {
    if (error instanceof CollectorUnavailable) throw error;
    throw new CollectorUnavailable(503);
  }
}

const issueSchema = z.strictObject({
  ...lifecycleSchema.shape,
  id: z.string().regex(/^[a-f0-9]{64}$/),
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
const issuePageSchema = z.strictObject({
  apiVersion: z.literal(1),
  items: z.array(issueSchema).max(100),
  nextCursor: z.string().max(1024).nullable(),
});
export type IssuePage = z.infer<typeof issuePageSchema>;
export type IssueDetail = {
  issue: z.infer<typeof issueSchema>;
  occurrences: Omit<IncidentPage, 'apiVersion'>;
};
export async function listIssues(
  service?: string,
  cursor?: string,
  filters: { q?: string; status?: string; from?: string; to?: string } = {},
): Promise<IssuePage> {
  const query = new URLSearchParams({ limit: '25' });
  if (service) query.set('service', service);
  if (cursor) query.set('cursor', cursor);
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const parsed = issuePageSchema.safeParse(await request(`/v1/issues?${query}`));
  if (!parsed.success) throw new CollectorUnavailable(503);
  return parsed.data;
}
export async function getIssue(id: string, cursor?: string): Promise<IssueDetail> {
  const query = new URLSearchParams({ limit: '25' });
  if (cursor) query.set('cursor', cursor);
  const parsed = z
    .strictObject({
      apiVersion: z.literal(1),
      issue: issueSchema,
      occurrences: pageSchema.omit({ apiVersion: true }),
    })
    .safeParse(await request(`/v1/issues/${encodeURIComponent(id)}?${query}`));
  if (!parsed.success) throw new CollectorUnavailable(503);
  return parsed.data;
}

export async function resolveIssue(
  id: string,
  input: { incidentId: string; runId: string; revision: number },
) {
  const config = await requireSession();
  const response = await fetch(`${config.collector}/v1/issues/${id}/resolve`, {
    method: 'POST',
    headers: {
      ...authHeaders(config),
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    throw new CollectorUnavailable(503);
  });
  if (!response.ok) throw new CollectorUnavailable(response.status);
  return lifecycleSchema
    .extend({ apiVersion: z.literal(1) })
    .parse(await response.json());
}
