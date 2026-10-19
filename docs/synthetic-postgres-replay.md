# PostgreSQL writes and transactions in isolated replay

This mode runs real PostgreSQL 15 inside the same disposable Docker container as
an Express replay app. It uses a Unix socket and has no TCP listener. The container
keeps network=none, read-only root filesystem, non-root execution and no host mounts
or production environment variables. Database files live in /tmp tmpfs and disappear
when the run ends. The database profile gets a 256 MiB tmpfs, 512 MiB memory limit and
30-second executor deadline; normal recorded-read replay keeps its smaller limits.

It is a controlled reproduction with reviewed synthetic initial data, not a replay
of the production database state. No writes, transactions, passwords or production
rows are automatically recorded. Opt in for a route whose selected safe request
fields can be tested against synthetic data:

```json
{
  "method": "POST",
  "route": "/users/register",
  "bodyFields": ["handle"],
  "databaseMode": "synthetic-postgres"
}
```

The SDK explicitly bypasses PostgreSQL query recording on that approved route. The
capture carries a synthetic-database marker. Other routes retain the normal read-only
recorder. Partial requests, omitted HTTP dependencies and unsafe route templates still
block generation. A matching registered synthetic contract and captured artifact ID
are required; changing just the policy cannot enable arbitrary database replay.

## Application integration

Bake PostgreSQL 15 binaries into the reviewed image (see delivery-replay.Dockerfile).
Use createSyntheticPostgres from @timemachine/replay with an explicitly configured
pg.Client factory. The helper supplies its own temporary Unix socket, role, database
and timeouts; there is no connection URL option. Fixtures are trusted source statements
baked into the image, never SQL supplied from an incident. Do not use customer dumps.

```js
const fixtures = [
  'CREATE TABLE test_users (id SERIAL PRIMARY KEY, handle TEXT NOT NULL UNIQUE)',
];
const fixtureHash = syntheticPostgresFixtureHash(fixtures);
const sandbox = await createSyntheticPostgres(
  fixtures,
  (config) => new pg.Client(config),
);
```

Register an inputMode: synthetic-postgres contract with databaseFixtureHash: fixtureHash.
Its create function returns your app handler using sandbox.database, the matching
hash, request, validate, assert and close: sandbox.close. The provided database exposes
query(text, values) and connect() returning a transaction lease with query/release.
The first version uses one pg.Client and permits one transaction lease at a time.
It does not emulate a full connection pool, ORM or concurrent transaction scheduler.

validate must return true independently of successful-response assertions. For example,
on an HTTP 500 it checks that a failed registration left no user or audit row. Failing
these invariants aborts the replay; it cannot be reported as a reproduced failure.
assert must check the intended success response plus committed rows and relationships.
Returning HTTP 201 alone is not sufficient evidence of correct registration.

Fixture SQL hashes bind the initial schema and seeds to the contract. Changing fixtures
requires a new reviewed scenario/version and a new capture; it cannot silently change
an old failure's verification conditions. Keep close in a finally path if app creation
fails. The container executor additionally removes the entire sandbox after timeout
or interruption. This helper is designed for the controlled replay image, not a host
production service.

## Validate transaction behavior

Define reviewed initial test data, a safe request and meaningful invariants. Reproduce
the captured failure in the disposable database and assert that rolled-back operations
leave no partial rows. Build/register the developer's fix and verify the original
occurrence against its declared response, committed rows and relationships. Every run
starts fresh; it does not mutate live application or incident-storage databases.

Install PostgreSQL runtime binaries in the custom replay image for this mode; the
standard Node-only image builder does not add them automatically. The documented
reference profile uses PostgreSQL 15; other runtime versions need validation. See
[custom replay](custom-express-replay.md) and [Express deployment](express-setup.md).

New scenarios can expose databaseChecks(context), returning database-rollback or
database-commit checks with passed/failed/not-checked statuses. The registration
runner reports its actual row-count and relationship assertions through this callback.
Older images remain readable and their missing per-check data is labelled Not reported.
