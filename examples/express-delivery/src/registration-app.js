// Fix 'acton' to 'action', then restart pnpm demo and verify the original failure.
const AUDIT_COLUMN = 'acton';
export const registrationFixtures = [
  'CREATE TABLE test_users (id SERIAL PRIMARY KEY, handle TEXT NOT NULL UNIQUE)',
  'CREATE TABLE registration_audit (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES test_users(id), action TEXT NOT NULL)',
];
export function attachRegistration(app, database) {
  app.post('/users/register', async (request, response, next) => {
    const { handle } = request.body ?? {};
    // This example accepts synthetic handles only; no passwords or real identities.
    if (typeof handle !== 'string' || !/^tm-test-[a-z0-9-]{1,32}$/.test(handle))
      return response.status(400).json({ error: { code: 'INVALID_TEST_HANDLE' } });
    if (!database)
      return response.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED' } });
    let client;
    try {
      client = await database.connect();
      await client.query('BEGIN');
      const result = await client.query(
        'INSERT INTO test_users (handle) VALUES ($1) RETURNING id, handle',
        [handle],
      );
      const user = result.rows[0];
      await client.query(
        `INSERT INTO registration_audit (user_id, ${AUDIT_COLUMN}) VALUES ($1, $2)`,
        [user.id, 'registered'],
      );
      await client.query('COMMIT');
      response.status(201).json({ user });
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* Preserve original error. */
        }
      }
      next(error);
    } finally {
      client?.release();
    }
  });
}
