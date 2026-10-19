import type { AlertChannel, AlertDelivery } from './alerts.js';
import type {
  ResolveIssueInput,
  IssueLifecycle,
  IssueListOptions,
  IssuePage,
  IssueDetail,
} from './issues.js';
import type { IncidentListOptions, IncidentPage } from './list.js';
import type { Incident, ReplayFixture, ReplayRun } from '@timemachine/core';

export interface IncidentStore {
  save(
    incident: Incident,
    fixture?: ReplayFixture,
    emitAlerts?: boolean | readonly AlertChannel[],
  ): Promise<'created' | 'duplicate'>;
  claimAlerts(
    limit: number,
    leaseMs: number,
    channels?: readonly AlertChannel[],
  ): Promise<AlertDelivery[]>;
  finishAlert(
    id: string,
    lease: string,
    delivered: boolean,
    retryAt: number,
  ): Promise<void>;
  alertStats(): Promise<{ pending: number; failed: number }>;
  getWorkspace(): Promise<{ revision: number; document: string } | undefined>;
  saveWorkspace(document: string, revision: number): Promise<boolean>;
  getNotificationSettings(): Promise<
    { revision: number; ciphertext: string } | undefined
  >;
  saveNotificationSettings(ciphertext: string, revision: number): Promise<boolean>;
  get(id: string): Promise<Incident | undefined>;
  list(options: IncidentListOptions): Promise<IncidentPage>;
  listIssues(options: IssueListOptions): Promise<IssuePage>;
  getIssue(id: string, options: IncidentListOptions): Promise<IssueDetail | undefined>;
  resolveIssue(id: string, input: ResolveIssueInput): Promise<IssueLifecycle>;
  replayArtifactReferences?(): Promise<
    { artifactId: string; service: string; captures: number; retainUntil: string }[]
  >;
  getReplayFixture(id: string): Promise<ReplayFixture | undefined>;
  listReplayRuns(id: string): Promise<ReplayRun[]>;
  beginReplay(run: ReplayRun): Promise<boolean>;
  finishReplay(run: ReplayRun): Promise<void>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}

export class IncidentStoreError extends Error {
  constructor(
    readonly code:
      | 'INCIDENT_CONFLICT'
      | 'STORE_CAPACITY_EXCEEDED'
      | 'STORE_UNAVAILABLE'
      | 'ISSUE_NOT_FOUND'
      | 'ISSUE_CHANGED'
      | 'VERIFICATION_REQUIRED',
  ) {
    super(code);
    this.name = 'IncidentStoreError';
  }
}
