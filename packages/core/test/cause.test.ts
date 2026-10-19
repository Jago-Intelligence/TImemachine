import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { explainCause, parseIncidentJson } from '../src/index.js';
function incident() {
  const value = parseIncidentJson(
    readFileSync(new URL('./fixtures/node-http-candidate.json', import.meta.url), 'utf8'),
  );
  value.failure.name = 'TypeError';
  value.failure.frames = [{ file: 'app.js', line: 8, column: 43 }];
  value.failure.sourceAccess = {
    file: 'app.js',
    line: 8,
    column: 43,
    sourceHash: 'a'.repeat(64),
    field: 'rate',
    operation: 'toFixed',
    dependencyId: 'pricing',
  };
  value.recording = {
    version: 1,
    policyId: 'pricing',
    request: {
      method: 'POST',
      route: '/quote',
      body: { distanceKm: 10 },
      partial: false,
    },
    dependencies: [
      {
        id: 'pricing',
        origin: 'http://127.0.0.1:4330',
        method: 'GET',
        route: '/rates',
        statusCode: 200,
        body: { ratePerKm: 2, currency: 'USD' },
        partial: false,
        result: 'response',
      },
    ],
    truncated: false,
  };
  return value;
}
it('explains missing fields using source and dependency evidence without recommending a patch', () => {
  const cause = explainCause(incident());
  expect(cause.status).toBe('supported');
  expect(cause.explanation).toContain('undefined');
  expect(cause.explanation).toContain('"rate"');
  expect(cause.evidence.join(' ')).toContain('currency, ratePerKm');
});
it('refuses to infer absence from redacted, truncated, missing or conflicting data', () => {
  for (const change of [
    (value: ReturnType<typeof incident>) => {
      value.recording!.dependencies[0]!.partial = true;
    },
    (value: ReturnType<typeof incident>) => {
      value.recording!.truncated = true;
    },
    (value: ReturnType<typeof incident>) => {
      value.recording!.dependencies[0]!.body.rate = 2;
    },
    (value: ReturnType<typeof incident>) => {
      delete value.failure.sourceAccess;
    },
    (value: ReturnType<typeof incident>) => {
      value.failure.name = 'CapturedError';
    },
  ]) {
    const value = incident();
    change(value);
    expect(explainCause(value).status).toBe('insufficient');
  }
});

it('explains absent database columns only from complete, unique first-row evidence', () => {
  const value = incident();
  value.failure.sourceAccess!.dependencyType = 'postgres';
  value.failure.sourceAccess!.dependencyId = 'zone';
  value.recording!.postgres = [
    {
      id: 'zone',
      queryHash: 'b'.repeat(64),
      parameters: ['LOCAL'],
      rows: [{ rate_per_km: 2, currency: 'USD' }],
      rowCount: 1,
      result: 'rows',
      partial: false,
    },
  ];
  expect(explainCause(value)).toMatchObject({
    status: 'supported',
    title: 'Missing database column',
  });
  expect(explainCause(value).evidence.join(' ')).toContain('rate_per_km');
  const pg = value.recording!.postgres[0]!;
  pg.partial = true;
  expect(explainCause(value).status).toBe('insufficient');
  pg.partial = false;
  pg.rows = [];
  expect(explainCause(value).status).toBe('insufficient');
  pg.rows = [{ rate: 2 }];
  expect(explainCause(value).status).toBe('insufficient');
  pg.rows = [{ rate_per_km: 2 }];
  value.recording!.postgres.push(pg);
  expect(explainCause(value).status).toBe('insufficient');
});

it('explains null and wrong-type fields without displaying their values', () => {
  for (const [field, title, kind] of [
    [null, 'Null response field', 'null'],
    ['private-recorded-value', 'Wrong type for response field', 'string'],
    [false, 'Wrong type for response field', 'boolean'],
  ] as const) {
    const value = incident();
    value.failure.sourceAccess!.receiver = 'pricing';
    value.recording!.dependencies[0]!.body.rate = field;
    const cause = explainCause(value);
    expect(cause).toMatchObject({ status: 'supported', title });
    expect(cause.evidence.join(' ')).toContain(`Recorded field type: ${kind}`);
    expect(cause.evidence.join(' ')).toContain('pricing.rate.toFixed()');
    expect(JSON.stringify(cause)).not.toContain('private-recorded-value');
  }
});
it('supports string operations only for an incompatible recorded field type', () => {
  const value = incident();
  value.failure.sourceAccess!.operation = 'trim';
  value.recording!.dependencies[0]!.body.rate = 10;
  expect(explainCause(value)).toMatchObject({
    status: 'supported',
    title: 'Wrong type for response field',
  });
  value.recording!.dependencies[0]!.body.rate = 'valid';
  expect(explainCause(value).status).toBe('insufficient');
});
it('rejects source facts that do not match an error frame', () => {
  const value = incident();
  value.failure.sourceAccess!.line++;
  expect(explainCause(value).status).toBe('insufficient');
});
it('records HTTP and database failures without attributing the application failure to them', () => {
  const value = incident();
  delete value.failure.sourceAccess;
  value.recording!.dependencies[0]!.statusCode = 503;
  value.recording!.postgres = [
    {
      id: 'lookup',
      queryHash: 'b'.repeat(64),
      parameters: [],
      rows: [],
      rowCount: null,
      result: 'error',
      errorCode: '42703',
      partial: false,
    },
  ];
  const cause = explainCause(value);
  expect(cause.status).toBe('observed');
  expect(cause.explanation).toContain('not proof');
  expect(cause.evidence.join(' ')).toContain('HTTP 503');
  expect(cause.evidence.join(' ')).toContain('42703 (undefined column)');
});
it('does not treat a nearby failed call as source-linked or infer a transport failure reason', () => {
  const value = incident();
  delete value.failure.sourceAccess;
  value.recording!.dependencies[0]!.result = 'transport-error';
  value.recording!.dependencies[0]!.statusCode = null;
  value.recording!.truncated = true;
  const cause = explainCause(value);
  expect(cause.status).toBe('observed');
  expect(cause.evidence.join(' ')).toContain('transport failed');
  expect(cause.evidence.join(' ')).toContain('incomplete');
  expect(cause.explanation).not.toContain('DNS');
});
it('explains null and mismatched types in complete PostgreSQL rows', () => {
  const value = incident();
  Object.assign(value.failure.sourceAccess!, {
    dependencyType: 'postgres',
    dependencyId: 'lookup',
  });
  value.recording!.postgres = [
    {
      id: 'lookup',
      queryHash: 'b'.repeat(64),
      parameters: [],
      rows: [{ rate: null }],
      rowCount: 1,
      result: 'rows',
      partial: false,
    },
  ];
  expect(explainCause(value)).toMatchObject({
    status: 'supported',
    title: 'Null database column',
  });
  value.recording!.postgres[0]!.rows[0]!.rate = 'redacted-value';
  expect(explainCause(value)).toMatchObject({
    status: 'supported',
    title: 'Wrong type for database column',
  });
  value.recording!.postgres[0]!.partial = true;
  expect(explainCause(value).status).toBe('insufficient');
});
