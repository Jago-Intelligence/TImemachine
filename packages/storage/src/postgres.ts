import { deliveryChannel } from './alerts.js';
import {
  createIssueAlert,
  alertEventSchema,
  ALERT_MAX_ATTEMPTS,
  type AlertDelivery,
} from './alerts.js';
import {
  issueLifecycleSchema,
  resolveIssueSchema,
  verifiedResolution,
  issueId,
  issueIdSchema,
  summarizeIssue,
  issuePage,
  occurrencePage,
  validateIssueOptions,
  type IssueListOptions,
  type IssueSummary,
} from './issues.js';
import { incidentPage, validateListOptions } from './list.js';
import { and, asc, desc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  parseIncident,
  replayFixtureSchema,
  replayRunSchema,
  validateReplayBinding,
  type Incident,
} from '@timemachine/core';
import { createPool } from './pool.js';
import type { PostgresOptions } from './postgres-options.js';
import { incidents, replayRuns, issueStates, alertOutbox } from './schema.js';
import { IncidentStoreError, type IncidentStore } from './store.js';

export interface PostgresIncidentStore extends IncidentStore {
  /** Physically delete up to 1,000 expired records; repeat for a larger backlog. */
  pruneExpired(): Promise<number>;
}

export function createPostgresStore(options: PostgresOptions): PostgresIncidentStore {
  const { pool, config } = createPool(options);
  const db = drizzle(pool);
  let closing: Promise<void> | undefined;

  async function operation<T>(run: () => Promise<T>): Promise<T> {
    if (closing) throw new IncidentStoreError('STORE_UNAVAILABLE');
    try {
      return await run();
    } catch (error) {
      if (error instanceof IncidentStoreError) throw error;
      throw new IncidentStoreError('STORE_UNAVAILABLE');
    }
  }

  async function grouped(
    input: IssueListOptions,
    onlyId?: string,
  ): Promise<IssueSummary[]> {
    const options = validateIssueOptions(input);
    const result = await db.execute<{
      payload: unknown;
      count: string;
      first_seen: Date;
      last_seen: Date;
      status: string;
      revision: string;
      resolution: unknown;
    }>(sql`
      WITH active AS (
        SELECT issue_id, occurred_at, id, payload FROM timemachine_incidents
        WHERE expires_at > now()
        ${options.service ? sql`AND service_name = ${options.service}` : sql``}
        ${
          options.allowedServices
            ? options.allowedServices.length
              ? sql`AND service_name IN (${sql.join(
                  options.allowedServices.map((service) => sql`${service}`),
                  sql`, `,
                )})`
              : sql`AND false`
            : sql``
        }
        ${onlyId ? sql`AND issue_id = ${onlyId}` : sql``}
      ), counts AS (
        SELECT issue_id, count(*) AS count, min(occurred_at) AS first_seen, max(occurred_at) AS last_seen
        FROM active GROUP BY issue_id
      ), latest AS (
        SELECT DISTINCT ON (issue_id) issue_id, payload FROM active
        ORDER BY issue_id, occurred_at DESC, id DESC
      )
      SELECT latest.payload, counts.count, counts.first_seen, counts.last_seen, s.status, s.revision, s.resolution
      FROM counts JOIN latest USING (issue_id) JOIN timemachine_issue_states s ON s.id = counts.issue_id
      WHERE true
      ${options.status ? sql`AND s.status = ${options.status}` : sql``}
      ${options.from ? sql`AND counts.last_seen >= ${new Date(options.from)}` : sql``}
      ${options.to ? sql`AND counts.last_seen < ${new Date(options.to)}` : sql``}
      ${options.q ? sql`AND strpos(lower(concat_ws(' ', counts.issue_id, latest.payload #>> '{service,name}', latest.payload #>> '{service,environment}', latest.payload #>> '{failure,name}', latest.payload #>> '{failure,code}', (SELECT concat_ws(' ', event->>'method', event->>'route') FROM jsonb_array_elements(latest.payload->'timeline') AS event WHERE event->>'type' = 'http.request' LIMIT 1))), ${options.q.toLowerCase()}) > 0` : sql``}
      ${options.after ? sql`AND (counts.last_seen, counts.issue_id) < (${new Date(options.after.lastSeen)}, ${options.after.id})` : sql``}
      ORDER BY counts.last_seen DESC, counts.issue_id DESC
      LIMIT ${options.limit + 1}
    `);
    return result.rows.map((row) => ({
      ...summarizeIssue(
        parseIncident(row.payload),
        Number(row.count),
        new Date(row.first_seen).toISOString(),
        new Date(row.last_seen).toISOString(),
      ),
      ...issueLifecycleSchema.parse({
        status: row.status,
        revision: Number(row.revision),
        resolution: row.resolution,
      }),
    }));
  }

  return {
    async replayArtifactReferences() {
      return operation(async () => {
        const result = await db.execute<{
          artifact_id: string;
          service_name: string;
          captures: string;
          retain_until: string;
        }>(sql`
          SELECT COALESCE(replay_fixture->>'artifactId', payload->'recording'->>'artifactId') AS artifact_id,
            service_name, COUNT(*)::text AS captures, MAX(expires_at)::text AS retain_until
          FROM timemachine_incidents WHERE expires_at > NOW()
            AND COALESCE(replay_fixture->>'artifactId', payload->'recording'->>'artifactId') IS NOT NULL
          GROUP BY artifact_id, service_name
        `);
        return result.rows.map((row) => ({
          artifactId: row.artifact_id,
          service: row.service_name,
          captures: Number(row.captures),
          retainUntil: new Date(row.retain_until).toISOString(),
        }));
      });
    },
    async getWorkspace() {
      return operation(async () => {
        const result = await db.execute<{ revision: number; document: string }>(
          sql`SELECT revision, document FROM timemachine_workspace WHERE id=1`,
        );
        return result.rows[0];
      });
    },
    async saveWorkspace(document, revision) {
      if (Buffer.byteLength(document) > 524288) throw new Error('Workspace too large');
      return operation(async () => {
        const result =
          revision === 0
            ? await db.execute(
                sql`INSERT INTO timemachine_workspace (id,revision,document) VALUES (1,1,${document}) ON CONFLICT DO NOTHING RETURNING id`,
              )
            : await db.execute(
                sql`UPDATE timemachine_workspace SET document=${document}, revision=revision+1 WHERE id=1 AND revision=${revision} RETURNING id`,
              );
        return result.rows.length === 1;
      });
    },
    async getNotificationSettings() {
      return operation(async () => {
        const result = await db.execute<{ revision: number; ciphertext: string }>(
          sql`SELECT revision, ciphertext FROM timemachine_notification_settings WHERE id = 1`,
        );
        return result.rows[0];
      });
    },
    async saveNotificationSettings(ciphertext, revision) {
      if (ciphertext.length > 32768) throw new Error('Settings too large');
      return operation(async () => {
        const result =
          revision === 0
            ? await db.execute(
                sql`INSERT INTO timemachine_notification_settings (id, revision, ciphertext) VALUES (1, 1, ${ciphertext}) ON CONFLICT DO NOTHING RETURNING id`,
              )
            : await db.execute(
                sql`UPDATE timemachine_notification_settings SET ciphertext=${ciphertext}, revision=revision+1 WHERE id=1 AND revision=${revision} RETURNING id`,
              );
        return result.rows.length === 1;
      });
    },
    async save(input: Incident, fixtureInput, emitAlerts = false) {
      return operation(async () => {
        const incident = parseIncident({ ...input, id: input.id.toLowerCase() });
        const fixture = fixtureInput
          ? validateReplayBinding(incident, fixtureInput)
          : undefined;
        return db.transaction(async (tx) => {
          await tx
            .delete(incidents)
            .where(
              and(eq(incidents.id, incident.id), lte(incidents.expiresAt, sql`now()`)),
            );
          const created = await tx
            .insert(incidents)
            .values({
              id: incident.id,
              schemaVersion: incident.schemaVersion,
              serviceName: incident.service.name,
              issueId: issueId(incident),
              occurredAt: new Date(incident.occurredAt),
              expiresAt: sql`now() + ${config.retentionDays} * interval '1 day'`,
              payload: incident,
              ...(fixture ? { replayFixture: fixture } : {}),
            })
            .onConflictDoNothing({ target: incidents.id })
            .returning({ id: incidents.id });
          if (created.length) {
            // Create the lifecycle row first, then lock it. Concurrent occurrences
            // share this lock so only the first creation/reopening emits an alert.
            const initial = await tx
              .insert(issueStates)
              .values({ id: issueId(incident), revision: 1, status: 'open' })
              .onConflictDoNothing()
              .returning({ id: issueStates.id });
            const [previous] = await tx
              .select()
              .from(issueStates)
              .where(eq(issueStates.id, issueId(incident)))
              .for('update');
            if (!previous) throw new IncidentStoreError('STORE_UNAVAILABLE');
            const revision = initial.length ? 1 : previous.revision + 1;
            await tx
              .update(issueStates)
              .set({ revision, status: 'open' })
              .where(eq(issueStates.id, previous.id));
            if (
              (Array.isArray(emitAlerts) ? emitAlerts.length > 0 : emitAlerts) &&
              (initial.length || previous.status === 'resolved')
            ) {
              const event = createIssueAlert(
                incident,
                revision,
                previous.status === 'resolved',
              );
              for (const channel of Array.isArray(emitAlerts)
                ? [...new Set(emitAlerts)]
                : [undefined])
                await tx.insert(alertOutbox).values({
                  id: channel ? `${event.id}:${channel}` : event.id,
                  payload: event,
                  expiresAt: sql`now() + ${Math.min(7, config.retentionDays)} * interval '1 day'`,
                });
            }
            return 'created' as const;
          }
          const [existing] = await tx
            .select({ payload: incidents.payload, fixture: incidents.replayFixture })
            .from(incidents)
            .where(eq(incidents.id, incident.id));
          if (!existing) throw new IncidentStoreError('STORE_UNAVAILABLE');
          if (
            JSON.stringify(parseIncident(existing.payload)) !==
              JSON.stringify(incident) ||
            JSON.stringify(
              existing.fixture ? replayFixtureSchema.parse(existing.fixture) : undefined,
            ) !== JSON.stringify(fixture)
          ) {
            throw new IncidentStoreError('INCIDENT_CONFLICT');
          }
          return 'duplicate' as const;
        });
      });
    },
    async claimAlerts(limit, leaseMs, channels) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 10 ||
        !Number.isInteger(leaseMs) ||
        leaseMs < 1000 ||
        leaseMs > 60000
      )
        throw new Error('Invalid alert claim');
      return operation(async () => {
        await db.delete(alertOutbox).where(lte(alertOutbox.expiresAt, sql`now()`));
        const rows = await db.execute<{
          id: string;
          payload: unknown;
          attempts: number;
          lease: string;
        }>(sql`
          WITH candidates AS (
            SELECT id FROM timemachine_alert_outbox WHERE due_at <= now() AND attempts < ${ALERT_MAX_ATTEMPTS} AND expires_at > now() AND (length(id) = 36 OR ${
              channels
                ? sql`split_part(id, ':', 2) IN (${
                    channels.length
                      ? sql.join(
                          channels.map((channel) => sql`${channel}`),
                          sql`, `,
                        )
                      : sql`NULL`
                  })`
                : sql`true`
            })
            ORDER BY due_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
          ) UPDATE timemachine_alert_outbox a SET attempts = a.attempts + 1,
            lease = gen_random_uuid(), due_at = now() + ${leaseMs} * interval '1 millisecond'
          FROM candidates c WHERE a.id = c.id RETURNING a.id, a.payload, a.attempts, a.lease
        `);
        return rows.rows.map(
          (row) =>
            ({
              deliveryId: row.id,
              ...(deliveryChannel(row.id) ? { channel: deliveryChannel(row.id)! } : {}),
              event: alertEventSchema.parse(row.payload),
              attempt: row.attempts,
              lease: row.lease,
            }) satisfies AlertDelivery,
        );
      });
    },
    async finishAlert(id, lease, delivered, retryAt) {
      return operation(async () => {
        const match = and(eq(alertOutbox.id, id), eq(alertOutbox.lease, lease));
        if (delivered) await db.delete(alertOutbox).where(match);
        else
          await db
            .update(alertOutbox)
            .set({ lease: null, dueAt: new Date(retryAt) })
            .where(match);
      });
    },
    async alertStats() {
      return operation(async () => {
        const rows = await db.execute<{ pending: string; failed: string }>(sql`
          SELECT count(*) FILTER (WHERE NOT (attempts >= ${ALERT_MAX_ATTEMPTS} AND (lease IS NULL OR due_at <= now()))) AS pending,
          count(*) FILTER (WHERE attempts >= ${ALERT_MAX_ATTEMPTS} AND (lease IS NULL OR due_at <= now())) AS failed
          FROM timemachine_alert_outbox WHERE expires_at > now()
        `);
        return {
          pending: Number(rows.rows[0]?.pending ?? 0),
          failed: Number(rows.rows[0]?.failed ?? 0),
        };
      });
    },
    async get(id) {
      return operation(async () => {
        const [row] = await db
          .select({ payload: incidents.payload })
          .from(incidents)
          .where(
            and(eq(incidents.id, id.toLowerCase()), gt(incidents.expiresAt, sql`now()`)),
          );
        return row ? parseIncident(row.payload) : undefined;
      });
    },
    async list(input) {
      return operation(async () => {
        const options = validateListOptions(input);
        const rows = await db
          .select({ payload: incidents.payload })
          .from(incidents)
          .where(
            and(
              gt(incidents.expiresAt, sql`now()`),
              options.service ? eq(incidents.serviceName, options.service) : undefined,
              options.allowedServices
                ? options.allowedServices.length
                  ? inArray(incidents.serviceName, options.allowedServices)
                  : sql`false`
                : undefined,
              options.after
                ? or(
                    lt(incidents.occurredAt, new Date(options.after.occurredAt)),
                    and(
                      eq(incidents.occurredAt, new Date(options.after.occurredAt)),
                      lt(incidents.id, options.after.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(incidents.occurredAt), desc(incidents.id))
          .limit(options.limit + 1);
        return incidentPage(
          rows.map(({ payload }) => parseIncident(payload)),
          options,
        );
      });
    },
    async listIssues(input) {
      return operation(async () => {
        const options = validateIssueOptions(input);
        return issuePage(await grouped(options), options);
      });
    },
    async getIssue(id, input) {
      return operation(async () => {
        issueIdSchema.parse(id);
        const options = validateListOptions(input);
        const [issue] = await grouped({ limit: 1 }, id);
        if (!issue) return undefined;
        const rows = await db
          .select({ payload: incidents.payload })
          .from(incidents)
          .where(
            and(
              eq(incidents.issueId, id),
              gt(incidents.expiresAt, sql`now()`),
              options.after
                ? or(
                    lt(incidents.occurredAt, new Date(options.after.occurredAt)),
                    and(
                      eq(incidents.occurredAt, new Date(options.after.occurredAt)),
                      lt(incidents.id, options.after.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(incidents.occurredAt), desc(incidents.id))
          .limit(options.limit + 1);
        return {
          issue,
          occurrences: occurrencePage(
            rows.map((row) => parseIncident(row.payload)),
            options,
            id,
          ),
        };
      });
    },
    async resolveIssue(id, raw) {
      return operation(async () => {
        issueIdSchema.parse(id);
        const input = resolveIssueSchema.parse(raw);
        return db.transaction(async (tx) => {
          const [state] = await tx
            .select()
            .from(issueStates)
            .where(eq(issueStates.id, id))
            .for('update');
          const [incident] = await tx
            .select({ id: incidents.id })
            .from(incidents)
            .where(
              and(
                eq(incidents.id, input.incidentId),
                eq(incidents.issueId, id),
                gt(incidents.expiresAt, sql`now()`),
              ),
            );
          if (!state || !incident) throw new IncidentStoreError('ISSUE_NOT_FOUND');
          const [storedRun] = await tx
            .select({ payload: replayRuns.payload })
            .from(replayRuns)
            .where(
              and(
                eq(replayRuns.id, input.runId),
                eq(replayRuns.incidentId, input.incidentId),
              ),
            );
          const resolution = verifiedResolution(
            storedRun ? replayRunSchema.parse(storedRun.payload) : undefined,
            input,
            state.revision,
          );
          await tx
            .update(issueStates)
            .set({ status: 'resolved', resolution })
            .where(eq(issueStates.id, id));
          return issueLifecycleSchema.parse({
            status: 'resolved',
            revision: state.revision,
            resolution,
          });
        });
      });
    },
    async getReplayFixture(id) {
      return operation(async () => {
        const [row] = await db
          .select({ fixture: incidents.replayFixture })
          .from(incidents)
          .where(and(eq(incidents.id, id), gt(incidents.expiresAt, sql`now()`)));
        return row?.fixture ? replayFixtureSchema.parse(row.fixture) : undefined;
      });
    },
    async listReplayRuns(id) {
      return operation(async () => {
        const rows = await db
          .select({ payload: replayRuns.payload })
          .from(replayRuns)
          .innerJoin(incidents, eq(incidents.id, replayRuns.incidentId))
          .where(and(eq(incidents.id, id), gt(incidents.expiresAt, sql`now()`)))
          .orderBy(desc(replayRuns.startedAt), desc(replayRuns.id))
          .limit(20);
        return rows.map(({ payload }) => replayRunSchema.parse(payload));
      });
    },
    async beginReplay(input) {
      return operation(async () => {
        const run = replayRunSchema.parse(input);
        if (run.status !== 'running' || run.finishedAt)
          throw new IncidentStoreError('STORE_UNAVAILABLE');
        return db.transaction(async (tx) => {
          // A container exits itself after eight seconds. A minute-old slot is abandoned.
          const abandoned = await tx
            .select({ payload: replayRuns.payload })
            .from(replayRuns)
            .where(
              and(
                eq(replayRuns.status, 'running'),
                lt(replayRuns.startedAt, sql`now() - interval '60 seconds'`),
              ),
            );
          for (const { payload } of abandoned)
            await tx
              .update(replayRuns)
              .set({
                status: 'failed',
                payload: {
                  ...payload,
                  status: 'failed',
                  finishedAt: new Date().toISOString(),
                  errorCode: 'INTERRUPTED',
                },
              })
              .where(eq(replayRuns.id, payload.id));
          const [exists] = await tx
            .select({ id: incidents.id })
            .from(incidents)
            .where(
              and(eq(incidents.id, run.incidentId), gt(incidents.expiresAt, sql`now()`)),
            );
          if (!exists) throw new IncidentStoreError('STORE_UNAVAILABLE');
          const inserted = await tx
            .insert(replayRuns)
            .values({
              id: run.id,
              incidentId: run.incidentId,
              startedAt: new Date(run.startedAt),
              status: 'running',
              payload: run,
            })
            .onConflictDoNothing()
            .returning({ id: replayRuns.id });
          if (!inserted.length) return false;
          const history = await tx
            .select({ id: replayRuns.id })
            .from(replayRuns)
            .where(eq(replayRuns.incidentId, run.incidentId))
            .orderBy(desc(replayRuns.startedAt), desc(replayRuns.id))
            .offset(20);
          if (history.length)
            await tx.delete(replayRuns).where(
              inArray(
                replayRuns.id,
                history.map(({ id }) => id),
              ),
            );
          return true;
        });
      });
    },
    async finishReplay(input) {
      return operation(async () => {
        const run = replayRunSchema.parse(input);
        if (run.status === 'running' || !run.finishedAt)
          throw new IncidentStoreError('STORE_UNAVAILABLE');
        await db
          .update(replayRuns)
          .set({ status: run.status, payload: run })
          .where(
            and(
              eq(replayRuns.id, run.id),
              eq(replayRuns.incidentId, run.incidentId),
              eq(replayRuns.status, 'running'),
            ),
          );
      });
    },
    async isReady() {
      if (closing) return false;
      try {
        await db.select().from(incidents).limit(0);
        await db.select().from(alertOutbox).limit(0);
        return true;
      } catch {
        return false;
      }
    },
    async pruneExpired() {
      return operation(async () => {
        const expired = db
          .select({ id: incidents.id })
          .from(incidents)
          .where(lte(incidents.expiresAt, sql`now()`))
          .orderBy(asc(incidents.expiresAt))
          .limit(1000);
        const result = await db.delete(incidents).where(inArray(incidents.id, expired));
        await db.execute(
          sql`DELETE FROM timemachine_issue_states s WHERE NOT EXISTS (SELECT 1 FROM timemachine_incidents i WHERE i.issue_id = s.id)`,
        );
        await db.delete(alertOutbox).where(lte(alertOutbox.expiresAt, sql`now()`));
        return result.rowCount ?? 0;
      });
    },
    close() {
      closing ??= pool.end();
      return closing;
    },
  };
}
