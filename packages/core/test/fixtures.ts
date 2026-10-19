import { readFileSync } from 'node:fs';
import { parseIncidentJson } from '../src/index.js';

export function nodeIncident() {
  return parseIncidentJson(
    readFileSync(new URL('./fixtures/node-http-candidate.json', import.meta.url), 'utf8'),
  );
}

export function pythonIncident() {
  return parseIncidentJson(
    readFileSync(new URL('./fixtures/python-unsupported.json', import.meta.url), 'utf8'),
  );
}
