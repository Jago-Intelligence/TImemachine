import { randomUUID } from 'node:crypto';
import type { ReplayRun, Incident } from '@timemachine/core';
import type { IncidentStore } from '../src/store.js';
import { issueId } from '../src/issues.js';
export async function verifiedRun(store: IncidentStore, incident: Incident) {
  const revision = (await store.getIssue(issueId(incident), { limit: 1 }))!.issue
    .revision;
  const run: ReplayRun = {
    id: randomUUID(),
    incidentId: incident.id,
    artifactId: `sha256:${'a'.repeat(64)}`,
    issueRevision: revision,
    mode: 'current',
    startedAt: new Date().toISOString(),
    status: 'running',
    expected: { statusCode: 500, errorCode: 'HTTP_500' },
    target: { statusCode: 201, errorCode: null, outcome: 'scenario-assertions-passed' },
  };
  await store.beginReplay(run);
  const completed: ReplayRun = {
    ...run,
    status: 'not-reproduced',
    finishedAt: new Date().toISOString(),
    verification: 'matched',
    actual: {
      statusCode: 201,
      errorCode: null,
      outcome: 'scenario-assertions-passed',
      runtimeVersion: '24.0.0',
      timeline: [{ id: 'response', type: 'http.response', statusCode: 201, offsetMs: 1 }],
    },
  };
  await store.finishReplay(completed);
  return { incidentId: incident.id, runId: run.id, revision };
}
