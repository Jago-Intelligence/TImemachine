import { describe, expect, it } from 'vitest';
import { parseIncident } from '../src/index.js';
import { nodeIncident, pythonIncident } from './fixtures.js';

describe('replay eligibility', () => {
  it.each([
    'adapter-unsupported',
    'missing-fixtures',
    'uncontrolled-nondeterminism',
    'external-side-effects',
    'capture-incomplete',
  ])('preserves unsupported reason %s', (reason) => {
    expect(
      parseIncident({ ...nodeIncident(), replay: { status: 'unsupported', reason } })
        .replay,
    ).toEqual({ status: 'unsupported', reason });
  });

  it('requires a fixture set reference for candidates', () => {
    expect(() =>
      parseIncident({
        ...nodeIncident(),
        replay: { status: 'candidate', mode: 'node-http-fixtures-v1' },
      }),
    ).toThrow('INVALID_INCIDENT');
  });

  it('requires the declared Node.js replay mode', () => {
    const incident = nodeIncident();
    incident.adapter.capabilities.replay = [];
    expect(() => parseIncident(incident)).toThrow('INVALID_INCIDENT');
  });

  it('does not allow a different runtime to claim the Node.js mode', () => {
    const incident = nodeIncident();
    incident.runtime = pythonIncident().runtime;
    expect(() => parseIncident(incident)).toThrow('INVALID_INCIDENT');
  });

  it('rejects incompatible adapter modes even when replay is unsupported', () => {
    const incident = pythonIncident();
    incident.adapter.capabilities.replay = ['node-http-fixtures-v1'];
    expect(() => parseIncident(incident)).toThrow('INVALID_INCIDENT');
  });

  it('requires HTTP handler context', () => {
    const incident = nodeIncident();
    incident.failure.source = 'unhandled-error';
    expect(() => parseIncident(incident)).toThrow('INVALID_INCIDENT');
    const missingRequest = nodeIncident();
    missingRequest.timeline = missingRequest.timeline.filter(
      (event) => event.type !== 'http.request',
    );
    expect(() => parseIncident(missingRequest)).toThrow('INVALID_INCIDENT');
  });

  it('rejects completed or guaranteed replay claims', () => {
    expect(() =>
      parseIncident({ ...nodeIncident(), replay: { status: 'supported' } }),
    ).toThrow('INVALID_INCIDENT');
  });
});
