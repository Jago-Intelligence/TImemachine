/** Version 1 wire limits; changing these can affect producer compatibility. */
export const INCIDENT_LIMITS = Object.freeze({
  bytes: 256 * 1024,
  timelineEvents: 1000,
  durationMs: 24 * 60 * 60 * 1000,
  identifierLength: 128,
  labelLength: 128,
  summaryLength: 2048,
  stackFrames: 50,
});

export const INCIDENT_SCHEMA_VERSION = 1 as const;
export const NODE_HTTP_REPLAY_MODE = 'node-http-fixtures-v1' as const;
