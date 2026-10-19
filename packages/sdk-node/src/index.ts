export { createTimeMachine } from './client.js';
export type { TimeMachineOptions } from './options.js';
export type {
  CaptureContext,
  CaptureResult,
  DeliveryStats,
  HttpHandler,
  TimeMachineClient,
} from './types.js';

export { createExpressInstrumentation, type ExpressRequest } from './express.js';

export {
  createFetchRecording,
  createFetchReplay,
  type FetchFixture,
} from './fetch-fixtures.js';

export { recordingPolicySchema, type RecordingPolicy } from './recording-policy.js';

export { automaticClientAdapters } from './automatic.js';
export { createClientAdapters } from './client-adapters.js';
export { installAxiosRecording } from './axios-adapter.js';

export { createTimeMachineFromConfig } from './config-client.js';
