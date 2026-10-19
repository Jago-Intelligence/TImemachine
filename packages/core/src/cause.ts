import type { Incident } from './incident.js';

export interface CauseExplanation {
  status: 'supported' | 'observed' | 'insufficient';
  title: string;
  explanation: string;
  evidence: string[];
}

/** Describe captured facts; dependency failure alone is never a causal link. */
function dependencyFacts(incident: Incident): CauseExplanation | undefined {
  const recording = incident.recording;
  if (!recording) return;
  const http = recording.dependencies.filter(
    (row) =>
      row.result === 'transport-error' ||
      (row.result === 'response' && row.statusCode !== null && row.statusCode >= 400),
  );
  const postgres = (recording.postgres ?? []).filter((row) => row.result === 'error');
  if (!http.length && !postgres.length) return;
  const codes: Record<string, string> = {
    '23505': 'unique constraint violation',
    '23503': 'foreign key violation',
    '23502': 'not-null constraint violation',
    '42703': 'undefined column',
    '42P01': 'undefined table',
    '42501': 'insufficient database privileges',
    '40001': 'serialization failure',
    '40P01': 'deadlock detected',
    ECONNREFUSED: 'database connection refused',
    ECONNRESET: 'connection reset',
    ETIMEDOUT: 'connection timed out',
    ENOTFOUND: 'database hostname lookup failed',
    EPIPE: 'connection closed while writing',
  };
  return {
    status: 'observed',
    title: 'Dependency failures recorded',
    explanation:
      'These dependency failures were recorded during this request. They are observed events, not proof that a particular dependency caused the application error. Review the source location and verify the scenario through replay.',
    evidence: [
      ...http.map(
        (row) =>
          `HTTP dependency ${row.id}: ${row.method} ${row.route} — ${row.result === 'transport-error' ? 'transport failed; no HTTP response was recorded' : `HTTP ${row.statusCode}`}.`,
      ),
      ...postgres.map(
        (row) =>
          `PostgreSQL dependency ${row.id}: ${row.errorCode ? `${row.errorCode}${codes[row.errorCode] ? ` (${codes[row.errorCode]})` : ''}` : 'query failed; no error code was recorded'}.`,
      ),
      ...(recording.truncated
        ? ['Recording coverage: incomplete; other dependency calls may be missing.']
        : []),
    ],
  };
}

export function explainCause(incident: Incident): CauseExplanation {
  const access = incident.failure.sourceAccess;
  const unknown = (reason: string): CauseExplanation =>
    dependencyFacts(incident) ?? {
      status: 'insufficient',
      title: 'More evidence needed',
      explanation: reason,
      evidence: [],
    };
  if (incident.failure.name !== 'TypeError' || !access)
    return unknown(
      'The capture identifies where the error occurred, but does not link the failing expression to a supported recorded response. Enable source evidence for the application file and capture a new occurrence.',
    );
  if (
    !incident.failure.frames.some(
      (frame) =>
        frame.file === access.file &&
        frame.line === access.line &&
        frame.column === access.column,
    )
  )
    return unknown('The source evidence does not match a captured error frame.');
  const recording = incident.recording;
  const database = access.dependencyType === 'postgres';
  const matches = database
    ? recording?.postgres?.filter((row) => row.id === access.dependencyId)
    : recording?.dependencies.filter((row) => row.id === access.dependencyId);
  if (!matches || matches.length !== 1)
    return unknown(
      'The source expression could not be linked to exactly one recorded dependency call.',
    );
  const dependency = matches[0]!;
  if (
    !recording ||
    recording.truncated ||
    dependency.partial ||
    (database ? dependency.result !== 'rows' : dependency.result !== 'response')
  )
    return unknown(
      'The linked response is incomplete or failed. An omitted field is not evidence that it was absent.',
    );
  const row = 'rows' in dependency ? dependency.rows[0] : dependency.body;
  if (!row)
    return unknown(
      'The recorded query returned no first row; this field-access rule cannot explain an absent row.',
    );
  const present = Object.prototype.hasOwnProperty.call(row, access.field);
  const value = row[access.field];
  const expected = access.operation === 'toFixed' ? 'number' : 'string';
  if (present && value !== null && typeof value === expected)
    return unknown(
      'The accessed field has the expected type in the recorded response. This rule does not explain the failure.',
    );
  const problem = !present ? 'missing' : value === null ? 'null' : 'wrong-type';
  const kind = database ? 'database column' : 'response field';
  const receiver = access.receiver;
  const expression = receiver
    ? `${receiver}.${access.field}.${access.operation}()`
    : `${access.field}.${access.operation}()`;
  return {
    status: 'supported',
    title: `${problem === 'wrong-type' ? 'Wrong type for' : problem === 'null' ? 'Null' : 'Missing'} ${kind}`,
    explanation: `The source expression reads "${access.field}" from ${database ? 'the first PostgreSQL result row' : `the ${dependency.id} response`}. ${!present ? `That complete recorded object has no "${access.field}" field; a missing property evaluates to undefined.` : value === null ? 'The recorded field is null.' : `The recorded field is a ${typeof value}, but .${access.operation}() requires a ${expected}.`} Calling .${access.operation}() ${!present || value === null ? 'on that value' : 'with this field type'} throws a TypeError. This links the source expression to the recorded data; replay can verify your change against this saved scenario.`,
    evidence: [
      `Source location: ${access.file}:${access.line}:${access.column ?? 1}.`,
      `Failing expression: ${expression}.`,
      `Recorded field type: ${!present ? 'undefined (field absent)' : value === null ? 'null' : typeof value}.`,
      `Recorded ${database ? 'columns' : 'response fields'}: ${Object.keys(row).sort().join(', ') || '(empty object)'}.`,
      ...('queryHash' in dependency
        ? [
            `Recorded PostgreSQL query: ${dependency.id}.`,
            `Query SHA-256: ${dependency.queryHash}.`,
          ]
        : [
            `Recorded dependency: ${dependency.method} ${dependency.route}, HTTP ${dependency.statusCode}.`,
          ]),
      `Source snapshot SHA-256: ${access.sourceHash}.`,
    ],
  };
}
