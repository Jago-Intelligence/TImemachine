import { describe, expect, it } from 'vitest';
import {
  INCIDENT_LIMITS,
  IncidentValidationError,
  parseIncident,
  parseIncidentJson,
} from '../src/index.js';
import { nodeIncident } from './fixtures.js';

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error('Expected validation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(IncidentValidationError);
    expect(error).toMatchObject({ code });
  }
}

describe('wire validation and compatibility', () => {
  it.each([0, 2, 99])('rejects unsupported version %s distinctly', (schemaVersion) => {
    expectCode(
      () => parseIncident({ ...nodeIncident(), schemaVersion }),
      'UNSUPPORTED_SCHEMA_VERSION',
    );
  });

  it.each([undefined, '1', 1.5, null])(
    'requires an integer schema version without coercion: %s',
    (schemaVersion) => {
      expectCode(
        () => parseIncident({ ...nodeIncident(), schemaVersion }),
        'INVALID_INCIDENT',
      );
    },
  );

  it.each(['', '{', 'undefined', '{"schemaVersion":1,}'])(
    'distinguishes invalid JSON: %s',
    (wire) => {
      expectCode(() => parseIncidentJson(wire), 'INVALID_JSON');
    },
  );

  it('accepts the exact byte limit and rejects one additional byte', () => {
    const json = JSON.stringify(nodeIncident());
    const padding = ' '.repeat(
      INCIDENT_LIMITS.bytes - new TextEncoder().encode(json).byteLength,
    );
    expect(parseIncidentJson(json + padding).schemaVersion).toBe(1);
    expectCode(() => parseIncidentJson(json + padding + ' '), 'INCIDENT_TOO_LARGE');
  });

  it('counts UTF-8 bytes rather than JavaScript characters', () => {
    const wire = JSON.stringify('🙂'.repeat(INCIDENT_LIMITS.bytes / 4));
    expect(wire.length).toBeLessThan(INCIDENT_LIMITS.bytes);
    expectCode(() => parseIncidentJson(wire), 'INCIDENT_TOO_LARGE');
  });

  it('also enforces aggregate size on object input', () => {
    const incident = nodeIncident();
    incident.timeline = Array.from({ length: 1000 }, (_, index) => ({
      id: `event-${index}`,
      offsetMs: index,
      type: 'http.request',
      method: 'GET',
      route: '/' + 'a'.repeat(255),
    }));
    expectCode(() => parseIncident(incident), 'INCIDENT_TOO_LARGE');
  });

  it('never includes submitted values or arbitrary unknown keys in errors', () => {
    const secret = 'private-token-do-not-log';
    let caught: unknown;
    try {
      parseIncident({ ...nodeIncident(), id: secret, [secret]: secret });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IncidentValidationError);
    const error = caught as IncidentValidationError;
    expect(error.fields).toContain('id');
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).toBe('INVALID_INCIDENT');
    expect(Object.isFrozen(error.fields)).toBe(true);
  });

  it('rejects unknown additions instead of silently dropping fields', () => {
    expectCode(
      () => parseIncident({ ...nodeIncident(), futureField: true }),
      'INVALID_INCIDENT',
    );
  });
});
