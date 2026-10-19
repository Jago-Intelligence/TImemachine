import { readFileSync } from 'node:fs';
import { parseIncidentJson } from '@timemachine/core';

export function fixture() {
  return parseIncidentJson(
    readFileSync(
      new URL('../../core/test/fixtures/node-http-candidate.json', import.meta.url),
      'utf8',
    ),
  );
}
