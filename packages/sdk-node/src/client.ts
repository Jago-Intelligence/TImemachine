import { createSourceInspector } from './source-evidence.js';
import { projectFrames } from './frames.js';
import { replayFixtureSchema } from '@timemachine/core';
import { buildIncident } from './capture.js';
import { wrapHandler } from './http.js';
import { parseOptions, type TimeMachineOptions } from './options.js';
import { createQueue } from './queue.js';
import type { CaptureContext, CaptureResult, TimeMachineClient } from './types.js';

export function createTimeMachine(options: TimeMachineOptions): TimeMachineClient {
  const config = parseOptions(options);
  const inspect = createSourceInspector(config.sourceRoot, config.sourceEvidenceFiles);
  const queue = createQueue(config);
  function captureException(error: unknown, context: CaptureContext = {}): CaptureResult {
    if (!queue.isAccepting()) return queue.reject();
    try {
      const incident = buildIncident(
        config,
        error,
        context,
        inspect(projectFrames(error, config.sourceRoot), context.recording),
      );
      const body = JSON.stringify(
        context.replayFixture
          ? {
              captureVersion: 1,
              incident,
              replayFixture: replayFixtureSchema.parse(context.replayFixture),
            }
          : incident,
      );
      return queue.enqueue({
        id: incident.id,
        correlationId: incident.correlation.correlationId,
        body,
        bytes: Buffer.byteLength(body),
      });
    } catch {
      return queue.reject();
    }
  }
  return {
    captureException,
    wrapHttpHandler: (route, handler) => wrapHandler(route, handler, captureException),
    flush: (options) => queue.flush(options?.timeoutMs),
    close: (options) => queue.close(options?.timeoutMs),
    getStats: queue.stats,
  };
}
