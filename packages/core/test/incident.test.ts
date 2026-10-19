import { describe, expect, it } from 'vitest';
import { INCIDENT_LIMITS, IncidentValidationError, parseIncident } from '../src/index.js';
import { nodeIncident, pythonIncident } from './fixtures.js';

function invalid(input: unknown, field: string) {
  try {
    parseIncident(input);
    throw new Error('Expected invalid incident');
  } catch (error) {
    expect(error).toBeInstanceOf(IncidentValidationError);
    expect(error).toMatchObject({ code: 'INVALID_INCIDENT' });
    expect((error as IncidentValidationError).fields).toContain(field);
  }
}

describe('incident v1', () => {
  it('accepts the sanitized Node.js candidate fixture', () => {
    const incident = nodeIncident();
    expect(incident.schemaVersion).toBe(1);
    expect(incident.replay.status).toBe('candidate');
    expect(parseIncident(incident)).toEqual(incident);
  });

  it('supports other languages without claiming replay support', () => {
    expect(pythonIncident()).toMatchObject({
      runtime: { language: 'python' },
      replay: { status: 'unsupported' },
    });
  });

  it.each([null, [], 'incident', 42, {}])('rejects non-incidents: %j', (input) => {
    expect(() => parseIncident(input)).toThrow(IncidentValidationError);
  });

  it('requires an incident UUID and safe correlation identifiers', () => {
    invalid({ ...nodeIncident(), id: 'invalid' }, 'id');
    const incident = nodeIncident();
    invalid(
      {
        ...incident,
        correlation: { ...incident.correlation, requestId: 'request\nforged-log' },
      },
      'correlation.requestId',
    );
  });

  it.each(['request\n', 'request\r', 'request\u2028'])(
    'rejects trailing control characters in IDs: %j',
    (requestId) => {
      const incident = nodeIncident();
      invalid(
        { ...incident, correlation: { ...incident.correlation, requestId } },
        'correlation.requestId',
      );
    },
  );

  it('requires UTC millisecond timestamps and capture after occurrence', () => {
    invalid({ ...nodeIncident(), occurredAt: '2026-10-12' }, 'occurredAt');
    invalid({ ...nodeIncident(), occurredAt: '2026-10-12T20:00:00Z' }, 'occurredAt');
    invalid({ ...nodeIncident(), capturedAt: '2026-10-12T19:59:59.000Z' }, 'capturedAt');
  });

  it('rejects raw payload fields at every boundary', () => {
    const incident = nodeIncident();
    for (const input of [
      { ...incident, payload: { token: 'never-store-this' } },
      { ...incident, service: { ...incident.service, password: 'never-store-this' } },
      { ...incident, failure: { ...incident.failure, stack: 'raw stack' } },
      {
        ...incident,
        timeline: [{ ...incident.timeline[0], headers: { authorization: 'private' } }],
      },
    ]) {
      expect(() => parseIncident(input)).toThrow('INVALID_INCIDENT');
    }
  });

  it('bounds summaries and stack frames', () => {
    const incident = nodeIncident();
    invalid(
      {
        ...incident,
        failure: {
          ...incident.failure,
          summary: 'x'.repeat(INCIDENT_LIMITS.summaryLength + 1),
        },
      },
      'failure.summary',
    );
    invalid(
      {
        ...incident,
        failure: {
          ...incident.failure,
          frames: Array.from({ length: INCIDENT_LIMITS.stackFrames + 1 }, () => ({
            file: 'src/index.ts',
            line: 1,
          })),
        },
      },
      'failure.frames',
    );
  });

  it.each([
    'src/index.ts\n',
    'src/./index.ts',
    'src//index.ts',
    '/home/user/index.ts',
    '../index.ts',
    'src/../index.ts',
    'C:\\Users\\private.ts',
    'https://host/index.ts?token=secret',
  ])('rejects unsafe stack file %s', (file) => {
    const incident = nodeIncident();
    invalid(
      { ...incident, failure: { ...incident.failure, frames: [{ file, line: 1 }] } },
      'failure.frames.0.file',
    );
  });

  it('rejects duplicate capabilities and undeclared event capture', () => {
    const incident = nodeIncident();
    invalid(
      {
        ...incident,
        adapter: {
          ...incident.adapter,
          capabilities: { capture: ['errors', 'errors'], replay: [] },
        },
      },
      'adapter.capabilities.capture',
    );
    invalid(
      {
        ...incident,
        adapter: {
          ...incident.adapter,
          capabilities: { capture: ['errors'], replay: [] },
        },
      },
      'adapter.capabilities.capture',
    );
  });

  it('does not mutate the submitted fixture', () => {
    const incident = nodeIncident();
    const before = JSON.stringify(incident);
    const parsed = parseIncident(incident);
    parsed.service.name = 'another-service';
    expect(JSON.stringify(incident)).toBe(before);
  });
});
