import ts from 'typescript';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { HttpRecording } from '@timemachine/core';
import { createSourceInspector, inspectSourceAccess } from '../src/source-evidence.js';

const text = `const RATE_FIELD = 'rate';
export function calculateFee(pricing, distanceKm) {
  return Number(pricing[RATE_FIELD].toFixed(2)) * distanceKm;
}
async function route() {
  const result = await globalThis.fetch('http://127.0.0.1:4330/rates');
  return calculateFee(await result.json(), 10);
}`;
const source = ts.createSourceFile('app.js', text, ts.ScriptTarget.Latest, true);
function location(position: number) {
  const place = source.getLineAndCharacterOfPosition(position);
  return { file: 'app.js', line: place.line + 1, column: place.character + 1 };
}
const frames = [
  location(text.indexOf('toFixed')),
  location(text.indexOf('calculateFee(await')),
];
const recording: HttpRecording = {
  version: 1,
  policyId: 'pricing',
  request: { method: 'POST', route: '/quote', body: { distanceKm: 10 }, partial: false },
  dependencies: [
    {
      id: 'pricing',
      origin: 'http://127.0.0.1:4330',
      method: 'GET',
      route: '/rates',
      statusCode: 200,
      body: { ratePerKm: 2 },
      partial: false,
      result: 'response',
    },
  ],
  truncated: false,
};
it('links a captured numeric field access to its fetch JSON dependency without source text', () => {
  const evidence = inspectSourceAccess(source, frames, recording);
  expect(evidence).toMatchObject({
    field: 'rate',
    operation: 'toFixed',
    dependencyId: 'pricing',
    file: 'app.js',
  });
  expect(evidence?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(evidence)).not.toContain('export function');
});
it('does not guess when data flow or the response binding is ambiguous', () => {
  expect(inspectSourceAccess(source, [frames[0]!], recording)).toBeUndefined();
  expect(
    inspectSourceAccess(source, frames, { ...recording, dependencies: [] }),
  ).toBeUndefined();
  expect(
    inspectSourceAccess(source, frames, {
      ...recording,
      dependencies: [...recording.dependencies, ...recording.dependencies],
    }),
  ).toBeUndefined();
  const unsafe = ts.createSourceFile(
    'app.js',
    text + "\nconst RATE_FIELD = 'another';",
    ts.ScriptTarget.Latest,
    true,
  );
  expect(inspectSourceAccess(unsafe, frames, recording)).toBeUndefined();
});
it('keeps startup evidence after the source file is edited and ignores unapproved files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tm-source-evidence-'));
  try {
    writeFileSync(join(directory, 'app.js'), text);
    const inspect = createSourceInspector(directory, ['app.js']);
    writeFileSync(join(directory, 'app.js'), text.replace("'rate'", "'ratePerKm'"));
    expect(inspect(frames, recording)?.field).toBe('rate');
    expect(createSourceInspector(directory)(frames, recording)).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('recognizes the actual delivery example source without executing or editing it', () => {
  const root = join(import.meta.dirname, '../../..');
  const file = 'examples/express-delivery/src/app.js';
  const actual = readFileSync(join(root, file), 'utf8');
  const parsed = ts.createSourceFile(file, actual, ts.ScriptTarget.Latest, true);
  const frames = [actual.indexOf('toFixed'), actual.indexOf('calculateFee(await')].map(
    (position) => {
      expect(position).toBeGreaterThan(0);
      const place = parsed.getLineAndCharacterOfPosition(position);
      return { file, line: place.line + 1, column: place.character + 1 };
    },
  );
  const field = /const RATE_FIELD = '([^']+)'/.exec(actual)?.[1];
  expect(createSourceInspector(root, [file])(frames, recording)?.field).toBe(field);
});

it('links an inline PostgreSQL first-row access and rejects ambiguous queries', async () => {
  const { createHash } = await import('node:crypto');
  const sql = 'select rate_per_km, currency from delivery_zones where zone_code = $1';
  const text = `const FIELD = 'rate';
const SQL = '${sql}';
async function handler(database) {
  const result = await database.query(SQL, ['LOCAL']);
  const row = result.rows[0];
  return row[FIELD].toFixed(2);
}`;
  const source = ts.createSourceFile('app.js', text, ts.ScriptTarget.Latest, true);
  const location = source.getLineAndCharacterOfPosition(text.indexOf('toFixed'));
  const frames = [
    { file: 'app.js', line: location.line + 1, column: location.character + 1 },
  ];
  const pg = {
    id: 'zone',
    queryHash: createHash('sha256').update(sql).digest('hex'),
    parameters: ['LOCAL'],
    rows: [{ rate_per_km: 2, currency: 'USD' }],
    rowCount: 1,
    result: 'rows' as const,
    partial: false,
  };
  const recorded = { ...recording, postgres: [pg] };
  expect(inspectSourceAccess(source, frames, recorded)).toMatchObject({
    field: 'rate',
    dependencyType: 'postgres',
    dependencyId: 'zone',
  });
  expect(
    inspectSourceAccess(source, frames, { ...recorded, postgres: [pg, pg] }),
  ).toBeUndefined();
  const changed = ts.createSourceFile(
    'app.js',
    text.replace('return row', 'row.rate = 2; return row'),
    ts.ScriptTarget.Latest,
    true,
  );
  expect(inspectSourceAccess(changed, frames, recorded)).toBeUndefined();
});

it('recognizes the delivery database source without changing the developer fix', async () => {
  const { createHash } = await import('node:crypto');
  const root = join(import.meta.dirname, '../../..');
  const file = 'examples/express-delivery/src/database-app.js';
  const text = readFileSync(join(root, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const place = source.getLineAndCharacterOfPosition(text.indexOf('toFixed'));
  const sql = 'select rate_per_km, currency from delivery_zones where zone_code = $1';
  const recorded: HttpRecording = {
    ...recording,
    postgres: [
      {
        id: 'zone',
        queryHash: createHash('sha256').update(sql).digest('hex'),
        parameters: ['LOCAL'],
        rows: [{ rate_per_km: 2, currency: 'USD' }],
        rowCount: 1,
        result: 'rows',
        partial: false,
      },
    ],
  };
  const access = createSourceInspector(root, [file])(
    [{ file, line: place.line + 1, column: place.character + 1 }],
    recorded,
  );
  expect(access).toMatchObject({
    dependencyType: 'postgres',
    field: /const DATABASE_RATE_FIELD = '([^']+)'/.exec(text)?.[1],
  });
});

function inlineEvidence(text: string, recorded = recording) {
  const parsed = ts.createSourceFile('app.js', text, ts.ScriptTarget.Latest, true);
  const at = parsed.getLineAndCharacterOfPosition(
    text.search(/\b(?:toFixed|trim|toLowerCase|toUpperCase)\b/),
  );
  return inspectSourceAccess(
    parsed,
    [{ file: 'app.js', line: at.line + 1, column: at.character + 1 }],
    recorded,
  );
}
it('correlates inline fetch JSON and dot-property access with the recorded response', () => {
  const code = `async function route() {
    const response = await fetch('http://127.0.0.1:4330/rates');
    const pricing = await response.json();
    const rate = Number(pricing.rate.toFixed(2));
    return rate;
  }`;
  expect(inlineEvidence(code)).toMatchObject({
    field: 'rate',
    receiver: 'pricing',
    operation: 'toFixed',
    dependencyId: 'pricing',
  });
});
it('correlates Axios response.data and destructured data using a literal URL', () => {
  for (const code of [
    `import axios from 'axios'; async function route() { const response = await axios.get('http://127.0.0.1:4330/rates'); return response.data.rate.toFixed(2); }`,
    `import axios from 'axios'; async function route() { const { data: pricing } = await axios.get('http://127.0.0.1:4330/rates'); return Number(pricing.rate.toFixed(2)); }`,
    `import axios from 'axios'; const client = axios.create({ baseURL: 'http://127.0.0.1:4330' }); async function route() { const { data } = await client.get('/rates'); return data.rate.toFixed(2); }`,
  ])
    expect(inlineEvidence(code)).toMatchObject({
      field: 'rate',
      dependencyId: 'pricing',
    });
});
it('refuses mutated, aliased, escaped, optional or ambiguous inline bindings', () => {
  const prefix = `async function route() { const response = await fetch('http://127.0.0.1:4330/rates'); const pricing = await response.json();`;
  for (const code of [
    `${prefix} pricing.rate = 2; return pricing.rate.toFixed(2); }`,
    `${prefix} const alias = pricing; alias.rate = 2; return pricing.rate.toFixed(2); }`,
    `${prefix} mutate(pricing); return pricing.rate.toFixed(2); }`,
    `${prefix} delete pricing.rate; return pricing.rate.toFixed(2); }`,
    `${prefix} pricing.rate++; return pricing.rate.toFixed(2); }`,
    `${prefix} return pricing.rate?.toFixed(2); }`,
    `async function route(url) { const response = await fetch(url); const pricing = await response.json(); return pricing.rate.toFixed(2); }`,
    `async function route() { const response = await fetch('http://127.0.0.1:4330/rates', { method: 'POST' }); const pricing = await response.json(); return pricing.rate.toFixed(2); }`,
    `async function route(client) { const response = await client.get('http://127.0.0.1:4330/rates'); return response.data.rate.toFixed(2); }`,
  ])
    expect(inlineEvidence(code)).toBeUndefined();
  expect(
    inlineEvidence(`${prefix} return pricing.rate.toFixed(2); }`, {
      ...recording,
      dependencies: [...recording.dependencies, ...recording.dependencies],
    }),
  ).toBeUndefined();
});
it('accepts a dot-property access in the existing captured helper flow', () => {
  const code = text.replace('pricing[RATE_FIELD]', 'pricing.rate');
  const parsed = ts.createSourceFile('app.js', code, ts.ScriptTarget.Latest, true);
  const at = [code.indexOf('toFixed'), code.indexOf('calculateFee(await')].map(
    (position) => {
      const place = parsed.getLineAndCharacterOfPosition(position);
      return { file: 'app.js', line: place.line + 1, column: place.character + 1 };
    },
  );
  expect(inspectSourceAccess(parsed, at, recording)).toMatchObject({
    field: 'rate',
    receiver: 'pricing',
  });
});

it('rejects shadowed or reassigned client identities and sensitive field names', () => {
  for (const code of [
    `import axios from 'axios'; async function route(axios) { const {data} = await axios.get('http://127.0.0.1:4330/rates'); return data.rate.toFixed(2); }`,
    `import axios from 'axios'; axios.get = custom; async function route() { const {data} = await axios.get('http://127.0.0.1:4330/rates'); return data.rate.toFixed(2); }`,
    `function fetch(url) { return other(url); } async function route() { const response = await fetch('http://127.0.0.1:4330/rates'); const data = await response.json(); return data.rate.toFixed(2); }`,
    `async function route() { const response = await fetch('http://127.0.0.1:4330/rates'); const data = await response.json(); return data.accessToken.toFixed(2); }`,
  ])
    expect(inlineEvidence(code)).toBeUndefined();
});
it('captures string operations without uploading a source snippet', () => {
  for (const operation of ['trim', 'toLowerCase', 'toUpperCase']) {
    const code = `async function route() { const response = await fetch('http://127.0.0.1:4330/rates'); const data = await response.json(); return data.currency.${operation}(); }`;
    const value = inlineEvidence(code);
    expect(value).toMatchObject({ field: 'currency', operation, receiver: 'data' });
    expect(JSON.stringify(value)).not.toContain('async function');
  }
});
