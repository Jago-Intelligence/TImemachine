import { parseIncident } from './validation.js';
import {
  replayFixtureSchema,
  type ReplayAppRegistry,
  type ReplayFixture,
} from './replay-execution.js';
import { NODE_HTTP_REPLAY_MODE } from './limits.js';
import type { Incident } from './incident.js';

export function recordingBlocker(
  incident: Incident,
): 'recording-incomplete' | 'recording-route-unsupported' | null {
  const recording = incident.recording;
  if (!recording) return 'recording-incomplete';
  if (
    recording.request.partial ||
    recording.truncated ||
    recording.operations?.some((row) => row.partial || row.result !== 'rows') ||
    recording.postgres?.some(
      (row) =>
        row.partial ||
        row.result === 'omitted' ||
        (row.result === 'error' && !row.errorCode),
    ) ||
    recording.dependencies.some(
      (row) => row.partial || !row.origin || row.result !== 'response',
    )
  )
    return 'recording-incomplete';
  if (
    /[:{}*]/.test(recording.request.route) ||
    (['GET', 'HEAD'].includes(recording.request.method) &&
      Object.keys(recording.request.body).length > 0)
  )
    return 'recording-route-unsupported';
  return null;
}

/** Generate only from complete selected inputs and an explicitly trusted app build. */
export function generateRecordedReplay(
  incident: Incident,
  registry: ReplayAppRegistry,
): {
  incident: Incident;
  fixture?: ReplayFixture;
  reason:
    | 'recording-incomplete'
    | 'recording-route-unsupported'
    | 'app-unregistered'
    | 'artifact-unavailable'
    | 'missing-fixture'
    | null;
} {
  const reject = (
    reason: Exclude<ReturnType<typeof generateRecordedReplay>['reason'], null>,
  ) => ({ incident, reason });
  const response = incident.timeline.findLast((row) => row.type === 'http.response');
  if (
    incident.adapter.name !== 'sdk-node' ||
    incident.runtime.name !== 'node' ||
    !response ||
    response.type !== 'http.response' ||
    response.statusCode < 500
  )
    return reject('missing-fixture');
  if (
    incident.recording &&
    new TextEncoder().encode(JSON.stringify(incident.recording)).byteLength > 60000
  )
    return reject('recording-incomplete');
  if (recordingBlocker(incident)) return reject(recordingBlocker(incident)!);
  const recording = incident.recording!;
  const app = registry.apps.find((row) => row.service === incident.service.name);
  if (!app) return reject('app-unregistered');
  if (!recording.artifactId || recording.artifactId !== app.currentArtifactId)
    return reject('artifact-unavailable');
  const matches = app.fixtures.filter(
    (row) =>
      row.inputMode === (recording.databaseMode ?? 'recorded-http') &&
      row.method === recording.request.method &&
      row.route === recording.request.route &&
      row.failureCode === incident.failure.code,
  );
  if (matches.length !== 1) return reject('missing-fixture');
  const fixture = replayFixtureSchema.parse({ ...matches[0], recording });
  const promoted = parseIncident({
    ...incident,
    adapter: {
      ...incident.adapter,
      capabilities: {
        ...incident.adapter.capabilities,
        replay: [
          ...new Set([...incident.adapter.capabilities.replay, NODE_HTTP_REPLAY_MODE]),
        ],
      },
    },
    replay: {
      status: 'candidate',
      mode: NODE_HTTP_REPLAY_MODE,
      fixtureSetId: incident.id,
    },
  });
  return { incident: promoted, fixture, reason: null };
}
