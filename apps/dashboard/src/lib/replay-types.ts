import type { ReplayFixture, ReplayRun } from '@timemachine/core';
export interface ReplayInfo {
  apiVersion: 1;
  issue?:
    | {
        id: string;
        status: 'open' | 'resolved';
        revision: number;
        resolution: {
          resolvedAt: string;
          incidentId: string;
          runId: string;
          artifactId: string;
        } | null;
      }
    | undefined;
  backup?: 'backed-up' | 'not-backed-up' | undefined;
  available: boolean;
  reason:
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
    | null;
  fixture?: ReplayFixture | undefined;
  runs: ReplayRun[];
}
