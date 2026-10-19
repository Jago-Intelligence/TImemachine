import { randomUUID } from 'node:crypto';
import {
  generateRecordedReplay,
  validateReplayBinding,
  replayObservationSchema,
  replayExpectationSchema,
  matchesReplayExpectation,
  replayRunSchema,
  type ReplayFixture,
  type ReplayRun,
  type ReplayExpectation,
  type ReplayAppRegistry,
} from '@timemachine/core';
import { issueId, type IncidentStore } from '@timemachine/storage';
import { ReplayExecutionError, type ReplayExecutor } from '@timemachine/replay';
import { ApiError } from './errors.js';
export function createReplayService(
  store: IncidentStore,
  executor: ReplayExecutor | undefined,
  artifacts: readonly string[],
  currentArtifact: string | undefined,
  registry: ReplayAppRegistry = { apps: [] },
) {
  const idValue = (id: string) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new ApiError(400, 'INVALID_INCIDENT_ID');
    return id.toLowerCase();
  };
  async function info(input: string) {
    const id = idValue(input);
    const incident = await store.get(id);
    if (!incident) throw new ApiError(404, 'INCIDENT_NOT_FOUND');
    const fixture = await store.getReplayFixture(id);
    let reason:
      | 'recording-incomplete'
      | 'recording-route-unsupported'
      | 'missing-fixture'
      | 'runner-disabled'
      | 'artifact-unavailable'
      | 'image-restoring'
      | 'image-recovery-failed'
      | 'image-missing'
      | 'docker-unavailable'
      | 'app-unregistered'
      | null = null;
    if (!fixture)
      reason = incident.recording
        ? (generateRecordedReplay(incident, registry).reason ?? 'missing-fixture')
        : 'missing-fixture';
    else if (
      fixture.runner === 'express-app-v1' &&
      !registry.apps.some((app) => app.service === fixture.service)
    )
      reason = 'app-unregistered';
    else if (
      fixture.runner === 'express-app-v1' &&
      !registry.apps
        .find((app) => app.service === fixture.service)!
        .artifacts.includes(fixture.artifactId)
    )
      reason = 'artifact-unavailable';
    else if (!executor) reason = 'runner-disabled';
    else if (!artifacts.includes(fixture.artifactId)) reason = 'artifact-unavailable';
    if (reason === null && fixture && executor?.imageStatus) {
      const status = await executor.imageStatus(fixture.artifactId);
      if (status === 'restoring') reason = 'image-restoring';
      if (status === 'recovery-failed') reason = 'image-recovery-failed';
      if (status === 'missing') reason = 'image-missing';
      if (status === 'unreachable') reason = 'docker-unavailable';
    }
    if (fixture) {
      try {
        validateReplayBinding(incident, fixture);
      } catch {
        throw new ApiError(422, 'INVALID_REPLAY_FIXTURE');
      }
    }
    const issue = await store.getIssue(issueId(incident), { limit: 1 });
    return {
      ...(issue
        ? {
            issue: {
              id: issue.issue.id,
              status: issue.issue.status,
              revision: issue.issue.revision,
              resolution: issue.issue.resolution,
            },
          }
        : {}),
      backup:
        fixture && executor?.hasBackup?.(fixture.artifactId)
          ? ('backed-up' as const)
          : ('not-backed-up' as const),
      apiVersion: 1 as const,
      available: reason === null,
      reason,
      ...(fixture ? { fixture } : {}),
      runs: await store.listReplayRuns(id),
    };
  }
  return {
    info,
    async run(
      input: string,
      mode: 'captured' | 'current',
      targetInput?: ReplayExpectation,
    ) {
      const target = targetInput ? replayExpectationSchema.parse(targetInput) : undefined;
      if (target && mode !== 'current') throw new ApiError(400, 'INVALID_REQUEST');
      const id = idValue(input);
      const state = await info(id);
      if (
        state.fixture?.runner === 'express-orders-v1' &&
        state.fixture?.profile === 'auth-case-normalization-v1' &&
        target &&
        (target.statusCode !== 200 ||
          target.errorCode !== null ||
          target.outcome !== 'authenticated-test-user')
      )
        throw new ApiError(400, 'INVALID_REQUEST');
      if (!state.fixture) throw new ApiError(409, 'REPLAY_UNSUPPORTED');
      if (!executor) throw new ApiError(503, 'REPLAY_UNAVAILABLE');
      const savedFixture = state.fixture;
      const app =
        savedFixture.runner === 'express-app-v1'
          ? registry.apps.find((app) => app.service === savedFixture.service)
          : undefined;
      if (
        state.fixture.runner === 'express-app-v1' &&
        (!app || !app.artifacts.includes(state.fixture.artifactId))
      )
        throw new ApiError(409, 'REPLAY_ARTIFACT_UNAVAILABLE');
      if (state.fixture.runner === 'express-app-v1' && mode === 'current') {
        const registered = app!.fixtures.find(
          (f) =>
            f.profile === state.fixture!.profile &&
            f.contractHash ===
              (state.fixture!.runner === 'express-app-v1'
                ? state.fixture!.contractHash
                : ''),
        );
        if (!registered) throw new ApiError(409, 'REPLAY_SCENARIO_CHANGED');
        if (target && JSON.stringify(target) !== JSON.stringify(state.fixture.target))
          throw new ApiError(400, 'INVALID_REQUEST');
      }
      const artifactId =
        mode === 'current'
          ? (app?.currentArtifactId ?? currentArtifact)
          : state.fixture.artifactId;
      if (!artifactId || !artifacts.includes(artifactId))
        throw new ApiError(409, 'REPLAY_ARTIFACT_UNAVAILABLE');
      const incident = await store.get(id);
      if (!incident) throw new ApiError(404, 'INCIDENT_NOT_FOUND');
      const originalResponse = incident.timeline.findLast(
        (event) => event.type === 'http.response',
      );
      if (!originalResponse || originalResponse.type !== 'http.response')
        throw new ApiError(409, 'REPLAY_UNSUPPORTED');
      const issue = await store.getIssue(issueId(incident), { limit: 1 });
      const run: ReplayRun = {
        ...(issue ? { issueRevision: issue.issue.revision } : {}),
        id: randomUUID(),
        incidentId: id,
        artifactId,
        mode,
        startedAt: new Date().toISOString(),
        status: 'running',
        expected: {
          statusCode: originalResponse.statusCode,
          errorCode: incident.failure.code ?? null,
        },
        ...(target ? { target } : {}),
      };
      if (!(await store.beginReplay(run))) throw new ApiError(409, 'REPLAY_BUSY');
      let finished: ReplayRun;
      try {
        const fixture: ReplayFixture = { ...state.fixture, artifactId };
        const observation = replayObservationSchema.safeParse(
          await executor.run(fixture),
        );
        if (!observation.success) throw new ReplayExecutionError('INVALID_OUTPUT');
        const actual = observation.data;
        finished = {
          ...run,
          finishedAt: new Date().toISOString(),
          status: matchesReplayExpectation(actual, run.expected)
            ? 'reproduced'
            : 'not-reproduced',
          actual,
          ...(target
            ? {
                verification: matchesReplayExpectation(actual, target)
                  ? ('matched' as const)
                  : ('not-matched' as const),
              }
            : {}),
        };
      } catch (error) {
        finished = {
          ...run,
          finishedAt: new Date().toISOString(),
          status: 'failed',
          errorCode:
            error instanceof ReplayExecutionError ? error.code : 'RUNNER_UNAVAILABLE',
        };
      }
      await store.finishReplay(replayRunSchema.parse(finished));
      return { apiVersion: 1, run: finished };
    },
  };
}
