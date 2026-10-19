import { IncidentValidationError } from '@timemachine/core';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { IncidentStoreError } from '@timemachine/storage';

const messages = {
  FORBIDDEN: 'You do not have access to this resource.',
  WORKSPACE_CONFLICT: 'Workspace settings changed. Refresh and retry.',
  INVALID_REPLAY_FIXTURE: 'The replay fixture is invalid or does not match the incident.',
  REPLAY_SCENARIO_CHANGED:
    'The replay scenario changed; compare builds using the original test contract.',
  REPLAY_UNSUPPORTED: 'This incident has no registered replay fixture.',
  REPLAY_UNAVAILABLE: 'The local replay runner is not configured.',
  REPLAY_ARTIFACT_UNAVAILABLE: 'The trusted replay artifact is unavailable.',
  REPLAY_BUSY: 'Another replay is running. Retry shortly.',

  UNAUTHORIZED: 'A valid bearer token is required.',
  INVALID_CORRELATION_ID: 'The correlation identifier is invalid.',
  INVALID_LIST_QUERY: 'The incident list query is invalid.',
  INVALID_ISSUE_ID: 'The issue identifier is invalid.',
  ISSUE_CHANGED:
    'New occurrences arrived after verification. Verify the latest issue state before resolving.',
  VERIFICATION_REQUIRED:
    'A successful current-build verification with business assertions is required.',
  ISSUE_NOT_FOUND: 'The issue was not found.',
  INVALID_INCIDENT_ID: 'The incident identifier is invalid.',
  INVALID_JSON: 'The request body must contain valid JSON.',
  INVALID_INCIDENT: 'The incident does not match the supported contract.',
  INCIDENT_TOO_LARGE: 'The incident exceeds the size limit.',
  UNSUPPORTED_SCHEMA_VERSION: 'The incident schema version is not supported.',
  UNSUPPORTED_MEDIA_TYPE: 'Use application/json with UTF-8 encoding.',
  SENSITIVE_INCIDENT_METADATA: 'The incident contains a collector credential.',
  INCIDENT_CONFLICT: 'An incident with this identifier already contains different data.',
  STORE_CAPACITY_EXCEEDED: 'Incident storage is at capacity. Retry later.',
  STORE_UNAVAILABLE: 'Incident storage is unavailable.',
  INCIDENT_NOT_FOUND: 'The incident was not found.',
  NOT_FOUND: 'The requested API route was not found.',
  RATE_LIMIT_EXCEEDED: 'Too many requests. Retry later.',
  SHUTTING_DOWN: 'The collector is shutting down.',
  INTERNAL_ERROR: 'The collector could not complete the request.',
  INVALID_REQUEST: 'The request is invalid.',
} as const;

type ErrorCode = keyof typeof messages;

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    readonly fields?: readonly string[],
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

function classify(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof IncidentValidationError) {
    const status =
      error.code === 'INCIDENT_TOO_LARGE'
        ? 413
        : error.code === 'INVALID_JSON'
          ? 400
          : 422;
    return new ApiError(status, error.code, error.fields);
  }
  if (error instanceof IncidentStoreError) {
    return new ApiError(
      error.code === 'ISSUE_NOT_FOUND'
        ? 404
        : ['INCIDENT_CONFLICT', 'ISSUE_CHANGED', 'VERIFICATION_REQUIRED'].includes(
              error.code,
            )
          ? 409
          : 503,
      error.code,
    );
  }
  if (typeof error !== 'object' || error === null)
    return new ApiError(500, 'INTERNAL_ERROR');
  const code = 'code' in error ? error.code : undefined;
  if (code === 'FST_ERR_BAD_URL') return new ApiError(400, 'INVALID_REQUEST');
  if (code === 'FST_ERR_MAX_PARAM_LENGTH') return new ApiError(414, 'INVALID_REQUEST');
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE')
    return new ApiError(413, 'INCIDENT_TOO_LARGE');
  if (
    code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
    code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH'
  ) {
    return new ApiError(
      code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' ? 400 : 415,
      code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH'
        ? 'INVALID_REQUEST'
        : 'UNSUPPORTED_MEDIA_TYPE',
    );
  }
  if ('statusCode' in error && error.statusCode === 429)
    return new ApiError(429, 'RATE_LIMIT_EXCEEDED');
  if ('statusCode' in error && error.statusCode === 400)
    return new ApiError(400, 'INVALID_REQUEST');
  return new ApiError(500, 'INTERNAL_ERROR');
}

export function sendApiError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (!request.correlationId) {
    request.correlationId = request.id;
    request.log = request.log.child({ correlationId: request.correlationId });
  }
  reply.header('x-request-id', request.id);
  reply.header('x-correlation-id', request.correlationId);
  reply.header('cache-control', 'no-store');
  reply.header('x-content-type-options', 'nosniff');
  const failure = classify(error);
  const fields = { errorCode: failure.code, operation: 'collector.request' };
  if (failure.statusCode >= 500) request.log.error(fields, 'Collector request failed');
  else request.log.warn(fields, 'Collector request rejected');
  if (failure.statusCode === 401)
    reply.header('www-authenticate', 'Bearer realm="timemachine"');
  return reply.code(failure.statusCode).send({
    apiVersion: 1,
    error: {
      code: failure.code,
      message: messages[failure.code],
      requestId: request.id,
      correlationId: request.correlationId,
      ...(failure.fields?.length ? { fields: failure.fields } : {}),
    },
  });
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(sendApiError);
  app.setNotFoundHandler(async () => {
    throw new ApiError(404, 'NOT_FOUND');
  });
}
