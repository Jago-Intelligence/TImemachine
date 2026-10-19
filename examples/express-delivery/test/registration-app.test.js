import { expect, it, vi } from 'vitest';
import { attachRegistration } from '../src/registration-app.js';
function handler(database) {
  let handle;
  attachRegistration(
    {
      post: (_route, callback) => {
        handle = callback;
      },
    },
    database,
  );
  return handle;
}
function reply() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() };
}
it('rolls back the user insertion when the audit write fails and releases its lease', async () => {
  const failure = new Error('audit write failure');
  const client = {
    query: vi.fn(async (sql) => {
      if (sql.startsWith('INSERT INTO test_users'))
        return { rows: [{ id: 1, handle: 'tm-test-one' }] };
      if (sql.startsWith('INSERT INTO registration_audit')) throw failure;
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const response = reply(),
    next = vi.fn();
  await handler({ connect: async () => client })(
    { body: { handle: 'tm-test-one' } },
    response,
    next,
  );
  expect(client.query.mock.calls.map((call) => call[0])).toEqual([
    'BEGIN',
    'INSERT INTO test_users (handle) VALUES ($1) RETURNING id, handle',
    expect.stringContaining('INSERT INTO registration_audit'),
    'ROLLBACK',
  ]);
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledWith(failure);
  expect(response.json).not.toHaveBeenCalled();
});
it('commits only after both writes succeed and rejects invalid input without database access', async () => {
  const client = {
    query: vi.fn(async () => ({ rows: [{ id: 1, handle: 'tm-test-one' }] })),
    release: vi.fn(),
  };
  const database = { connect: vi.fn(async () => client) },
    response = reply();
  await handler(database)({ body: { handle: 'tm-test-one' } }, response, vi.fn());
  expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');
  expect(response.status).toHaveBeenCalledWith(201);
  expect(client.release).toHaveBeenCalled();
  database.connect.mockClear();
  const invalid = reply();
  await handler(database)({ body: { handle: 'real-person' } }, invalid, vi.fn());
  expect(invalid.status).toHaveBeenCalledWith(400);
  expect(database.connect).not.toHaveBeenCalled();
});
