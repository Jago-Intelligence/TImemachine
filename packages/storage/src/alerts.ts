import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { incidentSchema, type Incident } from '@timemachine/core';
import { issueId, issueIdSchema } from './issues.js';
export const ALERT_MAX_ATTEMPTS = 5;
export const alertEventSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.enum(['issue.created', 'issue.reopened']),
  issueId: issueIdSchema,
  incidentId: z.uuid(),
  occurredAt: z.iso.datetime({ precision: 3 }),
  service: incidentSchema.shape.service.pick({ name: true, environment: true }),
  errorCode: incidentSchema.shape.failure.shape.code.nullable(),
  method: z.string().max(16).nullable(),
  route: z.string().max(256).nullable(),
});
export type AlertEvent = z.infer<typeof alertEventSchema>;
export const alertChannels = ['webhook', 'slack', 'email', 'teams', 'discord'] as const;
export type AlertChannel = (typeof alertChannels)[number];
export function deliveryChannel(id: string): AlertChannel | undefined {
  return alertChannels.find((channel) => id.endsWith(`:${channel}`));
}
export interface AlertDelivery {
  deliveryId?: string;
  channel?: AlertChannel;
  event: AlertEvent;
  attempt: number;
  lease: string;
}
export function createIssueAlert(
  incident: Incident,
  revision: number,
  reopened: boolean,
): AlertEvent {
  const http = incident.timeline.find((row) => row.type === 'http.request');
  const id = issueId(incident);
  return alertEventSchema.parse({
    version: 1,
    id: randomUUID(),
    revision,
    type: reopened ? 'issue.reopened' : 'issue.created',
    issueId: id,
    incidentId: incident.id,
    occurredAt: incident.occurredAt,
    service: { name: incident.service.name, environment: incident.service.environment },
    errorCode: incident.failure.code ?? null,
    method: http?.type === 'http.request' ? http.method : null,
    route: http?.type === 'http.request' ? http.route : null,
  });
}
export function alertLease() {
  return randomUUID();
}
