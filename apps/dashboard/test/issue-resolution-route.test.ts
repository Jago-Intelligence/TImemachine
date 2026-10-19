import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), session: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ requireSession: mocks.session }));
vi.mock('../src/lib/collector', () => ({
  resolveIssue: mocks.resolve,
  CollectorUnavailable: class extends Error {},
}));
import { POST } from '../src/app/api/issues/[id]/resolve/route';
const id = 'a'.repeat(64);
const body = {
  incidentId: '8b372947-b5ba-4b5f-8b84-3e53e686f014',
  runId: '284977b1-c89a-4d1b-8b74-247c59d08743',
  revision: 1,
};
beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.session.mockReset();
  mocks.session.mockResolvedValue({ origin: 'http://127.0.0.1:4321' });
  mocks.resolve.mockResolvedValue({ apiVersion: 1, status: 'resolved' });
});
function request(origin: string, data: string) {
  return new Request(`http://127.0.0.1:4321/api/issues/${id}/resolve`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: data,
  });
}
test('requires same origin and bounded validated JSON before contacting the collector', async () => {
  const params = { params: Promise.resolve({ id }) };
  expect(
    (await POST(request('http://other.invalid', JSON.stringify(body)), params)).status,
  ).toBe(403);
  expect(
    (await POST(request('http://127.0.0.1:4321', 'x'.repeat(513)), params)).status,
  ).toBe(400);
  expect(
    (
      await POST(
        request('http://127.0.0.1:4321', JSON.stringify({ ...body, status: 'resolved' })),
        params,
      )
    ).status,
  ).toBe(400);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(
    (await POST(request('http://127.0.0.1:4321', JSON.stringify(body)), params)).status,
  ).toBe(200);
  expect(mocks.resolve).toHaveBeenCalledWith(id, body);
});
test('requires a session before accepting a resolution decision', async () => {
  mocks.session.mockRejectedValue(new Error('Sign in required'));
  await expect(
    POST(request('http://127.0.0.1:4321', JSON.stringify(body)), {
      params: Promise.resolve({ id }),
    }),
  ).rejects.toThrow('Sign in required');
  expect(mocks.resolve).not.toHaveBeenCalled();
});
