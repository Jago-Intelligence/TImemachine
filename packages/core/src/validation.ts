import { incidentSchema, type Incident } from './incident.js';
import { INCIDENT_LIMITS, INCIDENT_SCHEMA_VERSION } from './limits.js';

export type IncidentValidationCode =
  | 'INVALID_JSON'
  | 'INCIDENT_TOO_LARGE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_INCIDENT';

export class IncidentValidationError extends Error {
  readonly code: IncidentValidationCode;
  readonly fields: readonly string[];

  constructor(code: IncidentValidationCode, fields: string[] = []) {
    super(code);
    this.name = 'IncidentValidationError';
    this.code = code;
    this.fields = Object.freeze([...new Set(fields)]);
  }
}

function assertSize(json: string): void {
  // Cheap precheck avoids allocating a large byte array for clearly oversized input.
  if (
    json.length > INCIDENT_LIMITS.bytes ||
    new TextEncoder().encode(json).byteLength > INCIDENT_LIMITS.bytes
  ) {
    throw new IncidentValidationError('INCIDENT_TOO_LARGE');
  }
}

/** Validate JSON-compatible, already-sanitized input; this does not sanitize secrets. */
export function parseIncident(input: unknown): Incident {
  if (
    typeof input === 'object' &&
    input !== null &&
    'schemaVersion' in input &&
    typeof input.schemaVersion === 'number' &&
    Number.isInteger(input.schemaVersion) &&
    input.schemaVersion !== INCIDENT_SCHEMA_VERSION
  ) {
    throw new IncidentValidationError('UNSUPPORTED_SCHEMA_VERSION', ['schemaVersion']);
  }
  const result = incidentSchema.safeParse(input);
  if (!result.success) {
    // Never surface Zod messages, unknown field names or submitted values to API callers.
    const fields = result.error.issues.map((issue) =>
      issue.path.length === 0 ? '$' : issue.path.map(String).join('.'),
    );
    throw new IncidentValidationError('INVALID_INCIDENT', fields);
  }
  assertSize(JSON.stringify(result.data));
  return result.data;
}

/** Collector entry point: enforce UTF-8 wire size before JSON parsing. */
export function parseIncidentJson(json: string): Incident {
  assertSize(json);
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    throw new IncidentValidationError('INVALID_JSON');
  }
  return parseIncident(input);
}
