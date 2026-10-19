import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  text,
  uuid,
  varchar,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { Incident, ReplayFixture, ReplayRun } from '@timemachine/core';

export const incidents = pgTable(
  'timemachine_incidents',
  {
    id: uuid('id').primaryKey(),
    issueId: varchar('issue_id', { length: 64 }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    serviceName: varchar('service_name', { length: 128 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    replayFixture: jsonb('replay_fixture').$type<ReplayFixture>(),
    payload: jsonb('payload').$type<Incident>().notNull(),
  },
  (table) => [
    index('timemachine_incidents_issue_idx').on(
      table.issueId,
      table.occurredAt,
      table.id,
    ),
    index('timemachine_incidents_list_idx').on(table.occurredAt, table.id),
    index('timemachine_incidents_service_list_idx').on(
      table.serviceName,
      table.occurredAt,
      table.id,
    ),
    index('timemachine_incidents_received_idx').on(table.receivedAt),
    index('timemachine_incidents_expiry_idx').on(table.expiresAt),
    index('timemachine_incidents_service_idx').on(table.serviceName, table.occurredAt),
    check('timemachine_incidents_schema_check', sql`${table.schemaVersion} = 1`),
    check(
      'timemachine_incidents_expiry_check',
      sql`${table.expiresAt} > ${table.receivedAt}`,
    ),
  ],
);

export const replayRuns = pgTable(
  'timemachine_replay_runs',
  {
    id: uuid('id').primaryKey(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    slot: integer('slot').notNull().default(1),
    payload: jsonb('payload').$type<ReplayRun>().notNull(),
  },
  (table) => [
    index('timemachine_replay_history_idx').on(table.incidentId, table.startedAt),
    uniqueIndex('timemachine_replay_running_idx')
      .on(table.slot)
      .where(sql`${table.status} = 'running'`),
    check('timemachine_replay_slot_check', sql`${table.slot} = 1`),
    check(
      'timemachine_replay_status_check',
      sql`${table.status} IN ('running', 'reproduced', 'not-reproduced', 'failed')`,
    ),
  ],
);

export const issueStates = pgTable(
  'timemachine_issue_states',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(1),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    resolution:
      jsonb('resolution').$type<import('./issues.js').IssueLifecycle['resolution']>(),
  },
  (table) => [
    check('timemachine_issue_states_revision_check', sql`${table.revision} > 0`),
    check(
      'timemachine_issue_states_status_check',
      sql`${table.status} IN ('open', 'resolved')`,
    ),
  ],
);

export const alertOutbox = pgTable(
  'timemachine_alert_outbox',
  {
    id: varchar('id', { length: 96 }).primaryKey(),
    payload: jsonb('payload').$type<import('./alerts.js').AlertEvent>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lease: uuid('lease'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now() + interval '7 days'`),
  },
  (table) => [
    index('timemachine_alert_due_idx').on(table.dueAt),
    check('timemachine_alert_attempts_check', sql`${table.attempts} BETWEEN 0 AND 5`),
  ],
);

export const notificationSettings = pgTable(
  'timemachine_notification_settings',
  {
    id: integer('id').primaryKey(),
    revision: integer('revision').notNull(),
    ciphertext: text('ciphertext').notNull(),
  },
  (table) => [
    check('timemachine_notification_settings_id_check', sql`${table.id} = 1`),
    check('timemachine_notification_settings_revision_check', sql`${table.revision} > 0`),
    check(
      'timemachine_notification_settings_ciphertext_check',
      sql`length(${table.ciphertext}) <= 32768`,
    ),
  ],
);

export const workspace = pgTable(
  'timemachine_workspace',
  {
    id: integer('id').primaryKey(),
    revision: integer('revision').notNull(),
    document: text('document').notNull(),
  },
  (table) => [
    check('timemachine_workspace_id_check', sql`${table.id} = 1`),
    check('timemachine_workspace_revision_check', sql`${table.revision} > 0`),
    check(
      'timemachine_workspace_document_check',
      sql`octet_length(${table.document}) <= 524288`,
    ),
  ],
);
