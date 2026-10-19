import { expect, it } from 'vitest';
import { projectFrames } from '../src/frames.js';

it('only extracts project-relative frames and strips raw message, function and outside paths', () => {
  const error = new Error('password=private');
  Object.defineProperty(error, 'stack', {
    value:
      'Error: password=private\n    at privateFunction (/project/src/orders.ts:42:7)\n    at outside (/other/customer.ts:2:1)\n    at dependency (/project/node_modules/pg/index.js:10:2)',
  });
  expect(projectFrames(error, '/project')).toEqual([
    { file: 'src/orders.ts', line: 42, column: 7 },
  ]);
  expect(projectFrames(error, undefined)).toEqual([]);
});
it('extracts native Node error locations and ignores application stack getters', () => {
  const error = new Error('private');
  expect(projectFrames(error, process.cwd()).length).toBeGreaterThan(0);
  Object.defineProperty(error, 'stack', {
    get: () => {
      throw new Error('Never call');
    },
  });
  expect(projectFrames(error, process.cwd())).toEqual([]);
});
it('never invokes custom message getters or admits traversal', () => {
  const error = new Error();
  Object.defineProperty(error, 'message', {
    get: () => {
      throw new Error('Never call');
    },
  });
  expect(projectFrames(error, '/project')).toEqual([]);
});
