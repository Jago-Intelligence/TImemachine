import { deliveryChannel } from './alerts.js';
import {
  createIssueAlert,
  alertLease,
  ALERT_MAX_ATTEMPTS,
  type AlertEvent,
} from './alerts.js';
import {
  memoryIssues,
  memoryIssueDetail,
  issueId,
  resolveIssueSchema,
  verifiedResolution,
  type IssueLifecycle,
} from './issues.js';
import { incidentPage, validateListOptions } from './list.js';
import {
  parseIncident,
  replayFixtureSchema,
  replayRunSchema,
  validateReplayBinding,
  type ReplayRun,
  type Incident,
} from '@timemachine/core';
import { IncidentStoreError, type IncidentStore } from './store.js';

interface MemoryStoreOptions {
  maxEntries: number;
  maxBytes: number;
  retentionMs: number;
  now?: () => number;
}

export function createMemoryStore(options: MemoryStoreOptions): IncidentStore {
  for (const value of [options.maxEntries, options.maxBytes, options.retentionMs]) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('Invalid memory store limits');
  }
  const now = options.now ?? Date.now;
  const entries = new Map<
    string,
    {
      json: string;
      bytes: number;
      expiresAt: number;
      fixture?: string;
      runs?: ReplayRun[];
    }
  >();
  const lifecycle = new Map<string, IssueLifecycle>();
  const alerts = new Map<
    string,
    {
      event: AlertEvent;
      attempt: number;
      lease: string | null;
      dueAt: number;
      expiresAt: number;
      bytes: number;
    }
  >();
  let notificationSettings: { revision: number; ciphertext: string } | undefined;
  let workspace: { revision: number; document: string } | undefined;
  let totalBytes = 0;
  let closed = false;

  function prune() {
    const time = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= time) {
        entries.delete(id);
        totalBytes -= entry.bytes;
      }
    }
    for (const [id, row] of alerts)
      if (row.expiresAt <= time) {
        alerts.delete(id);
        totalBytes -= row.bytes;
      }
    const active = new Set(
      [...entries.values()].map((entry) => issueId(JSON.parse(entry.json) as Incident)),
    );
    for (const id of lifecycle.keys()) if (!active.has(id)) lifecycle.delete(id);
  }

  return {
    async replayArtifactReferences() {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      const result = new Map<
        string,
        { artifactId: string; service: string; captures: number; retainUntil: string }
      >();
      for (const entry of entries.values()) {
        const incident = JSON.parse(entry.json) as Incident;
        const fixture = entry.fixture
          ? replayFixtureSchema.parse(JSON.parse(entry.fixture))
          : undefined;
        const artifactId = fixture?.artifactId ?? incident.recording?.artifactId;
        if (!artifactId) continue;
        const key = incident.service.name + ':' + artifactId;
        const row = result.get(key) ?? {
          artifactId,
          service: incident.service.name,
          captures: 0,
          retainUntil: new Date(entry.expiresAt).toISOString(),
        };
        row.captures++;
        row.retainUntil = new Date(
          Math.max(Date.parse(row.retainUntil), entry.expiresAt),
        ).toISOString();
        result.set(key, row);
      }
      return [...result.values()];
    },
    async getWorkspace() {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      return workspace ? { ...workspace } : undefined;
    },
    async saveWorkspace(document, revision) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      if (Buffer.byteLength(document) > 524288) throw new Error('Workspace too large');
      if ((workspace?.revision ?? 0) !== revision) return false;
      const delta =
        Buffer.byteLength(document) +
        128 -
        (workspace ? Buffer.byteLength(workspace.document) + 128 : 0);
      if (totalBytes + delta > options.maxBytes)
        throw new IncidentStoreError('STORE_CAPACITY_EXCEEDED');
      totalBytes += delta;
      workspace = { document, revision: revision + 1 };
      return true;
    },
    async getNotificationSettings() {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      return notificationSettings ? { ...notificationSettings } : undefined;
    },
    async saveNotificationSettings(ciphertext, revision) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      if (ciphertext.length > 32768) throw new Error('Settings too large');
      if ((notificationSettings?.revision ?? 0) !== revision) return false;
      const delta =
        Buffer.byteLength(ciphertext) +
        128 -
        (notificationSettings
          ? Buffer.byteLength(notificationSettings.ciphertext) + 128
          : 0);
      if (totalBytes + delta > options.maxBytes)
        throw new IncidentStoreError('STORE_CAPACITY_EXCEEDED');
      totalBytes += delta;
      notificationSettings = { ciphertext, revision: revision + 1 };
      return true;
    },
    async save(input, fixtureInput, emitAlerts = false) {
      const incident = parseIncident({ ...input, id: input.id.toLowerCase() });
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      const json = JSON.stringify(incident);
      const fixture = fixtureInput
        ? JSON.stringify(validateReplayBinding(incident, fixtureInput))
        : undefined;
      const existing = entries.get(incident.id);
      if (existing) {
        if (existing.json !== json || existing.fixture !== fixture)
          throw new IncidentStoreError('INCIDENT_CONFLICT');
        return 'duplicate';
      }
      const id = issueId(incident),
        previous = lifecycle.get(id);
      const alert =
        (Array.isArray(emitAlerts) ? emitAlerts.length > 0 : emitAlerts) &&
        (!previous || previous.status === 'resolved')
          ? createIssueAlert(
              incident,
              (previous?.revision ?? 0) + 1,
              previous?.status === 'resolved',
            )
          : undefined;
      const targets = Array.isArray(emitAlerts) ? [...new Set(emitAlerts)] : [undefined];
      const alertBytes = alert ? Buffer.byteLength(JSON.stringify(alert)) + 256 : 0;
      const bytes =
        512 + Buffer.byteLength(json) + (fixture ? Buffer.byteLength(fixture) : 0);
      if (
        entries.size >= options.maxEntries ||
        totalBytes + bytes + alertBytes * targets.length > options.maxBytes
      ) {
        throw new IncidentStoreError('STORE_CAPACITY_EXCEEDED');
      }
      entries.set(incident.id, {
        json,
        bytes,
        expiresAt: now() + options.retentionMs,
        ...(fixture ? { fixture } : {}),
      });
      totalBytes += bytes;
      if (alert)
        for (const target of targets) {
          alerts.set(target ? `${alert.id}:${target}` : alert.id, {
            event: alert,
            attempt: 0,
            lease: null,
            dueAt: now(),
            expiresAt: now() + options.retentionMs,
            bytes: alertBytes,
          });
          totalBytes += alertBytes;
        }
      lifecycle.set(id, {
        status: 'open',
        revision: (previous?.revision ?? 0) + 1,
        resolution: previous?.resolution ?? null,
      });
      return 'created';
    },
    async claimAlerts(limit, leaseMs, channels) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 10 ||
        !Number.isInteger(leaseMs) ||
        leaseMs < 1000 ||
        leaseMs > 60000
      )
        throw new Error('Invalid alert claim');
      prune();
      const result = [];
      for (const [deliveryId, row] of alerts) {
        const channel = deliveryChannel(deliveryId);
        if (channel && channels && !channels.includes(channel)) continue;
        if (result.length >= limit) break;
        if (row.attempt >= ALERT_MAX_ATTEMPTS || row.dueAt > now()) continue;
        row.attempt++;
        row.lease = alertLease();
        row.dueAt = now() + leaseMs;
        result.push({
          deliveryId,
          ...(channel ? { channel } : {}),
          event: structuredClone(row.event),
          attempt: row.attempt,
          lease: row.lease,
        });
      }
      return result;
    },
    async finishAlert(id, lease, delivered, retryAt) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      const row = alerts.get(id);
      if (!row || row.lease !== lease) return;
      if (delivered) {
        alerts.delete(id);
        totalBytes -= row.bytes;
      } else {
        row.lease = null;
        row.dueAt = Math.max(now(), retryAt);
      }
    },
    async alertStats() {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      let pending = 0,
        failed = 0;
      for (const row of alerts.values()) {
        if (
          row.attempt >= ALERT_MAX_ATTEMPTS &&
          (row.lease === null || row.dueAt <= now())
        )
          failed++;
        else pending++;
      }
      return { pending, failed };
    },
    async get(id) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      const entry = entries.get(id.toLowerCase());
      return entry ? (JSON.parse(entry.json) as Incident) : undefined;
    },
    async list(input) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      const options = validateListOptions(input);
      prune();
      const rows = [...entries.values()]
        .map(({ json }) => JSON.parse(json) as Incident)
        .filter(
          (row) =>
            (!options.service || row.service.name === options.service) &&
            (!options.allowedServices ||
              options.allowedServices.includes(row.service.name)),
        )
        .filter(
          (row) =>
            !options.after ||
            row.occurredAt < options.after.occurredAt ||
            (row.occurredAt === options.after.occurredAt && row.id < options.after.id),
        )
        .sort((a, b) =>
          a.occurredAt === b.occurredAt
            ? a.id < b.id
              ? 1
              : a.id > b.id
                ? -1
                : 0
            : a.occurredAt < b.occurredAt
              ? 1
              : -1,
        )
        .slice(0, options.limit + 1);
      return incidentPage(rows, options);
    },
    async listIssues(input) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      const page = memoryIssues(
        [...entries.values()].map((entry) => JSON.parse(entry.json) as Incident),
        input,
        lifecycle,
      );
      page.items = page.items.map((issue) => ({
        ...issue,
        ...structuredClone(lifecycle.get(issue.id)),
      }));
      return page;
    },
    async getIssue(id, input) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      const options = validateListOptions(input);
      const detail = memoryIssueDetail(
        [...entries.values()].map((entry) => JSON.parse(entry.json) as Incident),
        id,
        options,
      );
      if (detail)
        detail.issue = { ...detail.issue, ...structuredClone(lifecycle.get(id)) };
      return detail;
    },
    async resolveIssue(id, raw) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      const input = resolveIssueSchema.parse(raw),
        state = lifecycle.get(id);
      const entry = entries.get(input.incidentId);
      if (!state || !entry || issueId(JSON.parse(entry.json) as Incident) !== id)
        throw new IncidentStoreError('ISSUE_NOT_FOUND');
      const run = entry.runs?.find((run) => run.id === input.runId);
      const resolution = verifiedResolution(run, input, state.revision);
      const updated = { ...state, status: 'resolved' as const, resolution };
      lifecycle.set(id, updated);
      return structuredClone(updated);
    },
    async getReplayFixture(id) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      const entry = entries.get(id);
      return entry?.fixture
        ? replayFixtureSchema.parse(JSON.parse(entry.fixture))
        : undefined;
    },
    async listReplayRuns(id) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      return (entries.get(id)?.runs ?? [])
        .slice()
        .reverse()
        .map((run) => replayRunSchema.parse(structuredClone(run)));
    },
    async beginReplay(input) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      const run = replayRunSchema.parse(input);
      if (run.status !== 'running' || run.finishedAt)
        throw new IncidentStoreError('STORE_UNAVAILABLE');
      for (const entry of entries.values())
        for (const previous of entry.runs ?? []) {
          if (previous.status !== 'running') continue;
          if (Date.parse(previous.startedAt) > Date.now() - 60000) return false;
          previous.status = 'failed';
          previous.errorCode = 'INTERRUPTED';
          previous.finishedAt = new Date().toISOString();
          const bytes =
            512 +
            Buffer.byteLength(entry.json) +
            Buffer.byteLength(entry.fixture ?? '') +
            Buffer.byteLength(JSON.stringify(entry.runs));
          totalBytes += bytes - entry.bytes;
          entry.bytes = bytes;
        }
      const entry = entries.get(run.incidentId);
      if (!entry) throw new IncidentStoreError('STORE_UNAVAILABLE');
      const runs = [...(entry.runs ?? []), structuredClone(run)].slice(-20);
      const bytes =
        512 +
        Buffer.byteLength(entry.json) +
        Buffer.byteLength(entry.fixture ?? '') +
        Buffer.byteLength(JSON.stringify(runs)) +
        8192;
      if (totalBytes - entry.bytes + bytes > options.maxBytes)
        throw new IncidentStoreError('STORE_CAPACITY_EXCEEDED');
      totalBytes += bytes - entry.bytes;
      entry.bytes = bytes;
      entry.runs = runs;
      return true;
    },
    async finishReplay(input) {
      if (closed) throw new IncidentStoreError('STORE_UNAVAILABLE');
      prune();
      const run = replayRunSchema.parse(input);
      if (run.status === 'running' || !run.finishedAt)
        throw new IncidentStoreError('STORE_UNAVAILABLE');
      const entry = entries.get(run.incidentId);
      if (!entry) throw new IncidentStoreError('STORE_UNAVAILABLE');
      const index =
        entry.runs?.findIndex(
          (value) => value.id === run.id && value.status === 'running',
        ) ?? -1;
      if (index < 0 || !entry.runs) return;
      const runs = structuredClone(entry.runs);
      runs[index] = run;
      const bytes =
        512 +
        Buffer.byteLength(entry.json) +
        Buffer.byteLength(entry.fixture ?? '') +
        Buffer.byteLength(JSON.stringify(runs));
      if (totalBytes - entry.bytes + bytes > options.maxBytes)
        throw new IncidentStoreError('STORE_CAPACITY_EXCEEDED');
      totalBytes += bytes - entry.bytes;
      entry.bytes = bytes;
      entry.runs = runs;
    },
    async isReady() {
      prune();
      return (
        !closed && entries.size < options.maxEntries && totalBytes < options.maxBytes
      );
    },
    async close() {
      closed = true;
      entries.clear();
      lifecycle.clear();
      alerts.clear();
      totalBytes = 0;
    },
  };
}
