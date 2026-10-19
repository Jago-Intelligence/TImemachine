import { describe, expect, it } from 'vitest';
import { INCIDENT_LIMITS, parseIncident, timelineEventSchema } from '../src/index.js';
import { nodeIncident } from './fixtures.js';

describe('bounded timeline', () => {
  it('accepts the maximum event count and rejects one more', () => {
    const incident = nodeIncident();
    incident.replay = { status: 'unsupported', reason: 'capture-incomplete' };
    incident.timeline = Array.from(
      { length: INCIDENT_LIMITS.timelineEvents },
      (_, index) => ({
        id: `event-${index}`,
        offsetMs: index,
        type: 'error',
        code: 'EXAMPLE_FAILURE',
      }),
    );
    expect(parseIncident(incident).timeline).toHaveLength(INCIDENT_LIMITS.timelineEvents);
    incident.timeline.push({
      id: 'one-more',
      offsetMs: 1001,
      type: 'error',
      code: 'EXAMPLE_FAILURE',
    });
    expect(() => parseIncident(incident)).toThrow('INVALID_INCIDENT');
  });

  it('requires at least one event', () => {
    expect(() => parseIncident({ ...nodeIncident(), timeline: [] })).toThrow(
      'INVALID_INCIDENT',
    );
  });

  it('requires unique event IDs and chronological offsets', () => {
    const incident = nodeIncident();
    incident.timeline[1]!.id = incident.timeline[0]!.id;
    expect(() => parseIncident(incident)).toThrow('INVALID_INCIDENT');
    const reversed = nodeIncident();
    reversed.timeline.reverse();
    expect(() => parseIncident(reversed)).toThrow('INVALID_INCIDENT');
  });

  it('allows equal offsets without changing producer order', () => {
    const incident = nodeIncident();
    incident.timeline.forEach((event) => {
      event.offsetMs = 0;
    });
    expect(parseIncident(incident).timeline.map((event) => event.id)).toEqual(
      incident.timeline.map((event) => event.id),
    );
  });

  it.each([-1, 0.5, INCIDENT_LIMITS.durationMs + 1, Infinity, NaN])(
    'rejects invalid offset %s',
    (offsetMs) => {
      expect(
        timelineEventSchema.safeParse({
          id: 'event',
          offsetMs,
          type: 'error',
          code: 'FAILURE',
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    '/orders\n',
    '/orders?token=secret',
    'https://example.com/orders',
    '/orders#secret',
    '/orders with spaces',
  ])('rejects raw route %s', (route) => {
    expect(
      timelineEventSchema.safeParse({
        id: 'event',
        offsetMs: 0,
        type: 'http.request',
        method: 'GET',
        route,
      }).success,
    ).toBe(false);
  });

  it('accepts route templates and validates status codes', () => {
    expect(
      timelineEventSchema.safeParse({
        id: 'event',
        offsetMs: 0,
        type: 'http.request',
        method: 'GET',
        route: '/orders/:orderId',
      }).success,
    ).toBe(true);
    for (const statusCode of [99, 600, 200.5]) {
      expect(
        timelineEventSchema.safeParse({
          id: 'event',
          offsetMs: 0,
          type: 'http.response',
          statusCode,
        }).success,
      ).toBe(false);
    }
  });
});
