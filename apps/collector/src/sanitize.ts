import { parseIncident, type Incident } from '@timemachine/core';
import { ApiError } from './errors.js';

const builtInErrors = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
]);

function containsCredential(value: unknown, credential: string): boolean {
  if (typeof value === 'string')
    return value.includes(credential) || /(?:tm_|ws_)[a-f0-9]{64}/.test(value);
  if (Array.isArray(value))
    return value.some((item: unknown) => containsCredential(item, credential));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((item: unknown) =>
      containsCredential(item, credential),
    );
  }
  return false;
}

/** Conservative collector policy; producers still sanitize all remaining metadata. */
export function sanitizeIncident(incident: Incident, token: string): Incident {
  if (containsCredential(incident, token))
    throw new ApiError(422, 'SENSITIVE_INCIDENT_METADATA');
  return parseIncident({
    ...incident,
    id: incident.id.toLowerCase(),
    failure: {
      ...incident.failure,
      name: builtInErrors.has(incident.failure.name)
        ? incident.failure.name
        : 'CapturedError',
      summary: 'Failure details omitted by collector sanitization policy.',
      frames: incident.failure.frames.map(({ file, line, column }) => ({
        file,
        line,
        ...(column === undefined ? {} : { column }),
      })),
    },
  });
}
