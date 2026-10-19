import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpRecording, ReplayFixture, TimelineEvent } from '@timemachine/core';

export interface CaptureContext {
  /** UTC time the error was observed, distinct from delivery/capture time. */
  occurredAt?: string;
  recording?: HttpRecording;
  /** Bounded, reviewed dependency metadata. No URLs, headers or payloads. */
  dependencies?: Array<
    Omit<Extract<TimelineEvent, { type: 'dependency' }>, 'id' | 'type'>
  >;
  /** Explicit, allowlisted test inputs; never raw request bodies. */
  replayFixture?: ReplayFixture;
  /** Reviewed application code, never an error message or query. */
  code?: string;
  requestId?: string;
  correlationId?: string;
  http?: {
    method: Extract<TimelineEvent, { type: 'http.request' }>['method'];
    route: string;
    statusCode?: number;
    durationMs?: number;
    errorOffsetMs?: number;
  };
}

export type CaptureResult =
  | { queued: true; incidentId: string }
  | { queued: false; reason: 'closed' | 'queue-full' | 'invalid-context' };

export interface DeliveryStats {
  delivered: number;
  failed: number;
  dropped: number;
  pending: number;
  pendingBytes: number;
}

export type HttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

export interface TimeMachineClient {
  captureException(error: unknown, context?: CaptureContext): CaptureResult;
  wrapHttpHandler(route: string, handler: HttpHandler): HttpHandler;
  flush(options?: { timeoutMs?: number }): Promise<boolean>;
  close(options?: { timeoutMs?: number }): Promise<boolean>;
  getStats(): Readonly<DeliveryStats>;
}
