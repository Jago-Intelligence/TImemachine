import { expect, it } from 'vitest';
import {
  projectBody,
  recordingPolicySchema,
  responseBody,
} from '../src/recording-policy.js';

it('omits unselected fields, nested payloads and getters without evaluating them', () => {
  let read = false;
  const input = { quantity: 2, password: 'secret', nested: { private: true } };
  Object.defineProperty(input, 'getter', {
    enumerable: true,
    get() {
      read = true;
      return 'secret';
    },
  });
  expect(projectBody(input, ['quantity', 'nested', 'getter'])).toEqual({
    body: { quantity: 2 },
    partial: true,
  });
  expect(read).toBe(false);
});
it('rejects credential field names and credential-bearing origins', () => {
  const base = {
    id: 'test',
    requests: [{ method: 'POST', route: '/login', bodyFields: ['password'] }],
    dependencies: [],
  };
  expect(recordingPolicySchema.safeParse(base).success).toBe(false);
  expect(
    recordingPolicySchema.safeParse({
      ...base,
      requests: [],
      dependencies: [
        {
          id: 'api',
          method: 'GET',
          origin: 'https://user:secret@example.com',
          route: '/check',
          responseFields: [],
        },
      ],
    }).success,
  ).toBe(false);
});
it('bounds response clones and preserves the original response', async () => {
  const response = Response.json({ available: false, token: 'private' });
  expect(await responseBody(response, ['available'])).toEqual({
    body: { available: false },
    partial: true,
  });
  expect(await response.json()).toHaveProperty('token', 'private');
  expect(await responseBody(new Response('x'.repeat(9000)), ['available'])).toEqual({
    body: {},
    partial: true,
  });
});

it('does not treat JSON null or arrays as a complete response object', async () => {
  expect((await responseBody(Response.json(null), ['rate'])).partial).toBe(true);
  expect((await responseBody(Response.json([2]), ['rate'])).partial).toBe(true);
});
