# Durable incident storage

The collector uses the database-independent `IncidentStore` interface. Memory and
PostgreSQL adapters implement save, lookup, readiness and close. SDKs continue
sending the same HTTP incident format regardless of storage. Other databases can
implement this interface without changing SDKs; only PostgreSQL is durable today.

## Source-operated database setup

Install and start Docker Desktop, then run from the repository root:

```sh
pnpm db:setup
pnpm db:up
pnpm db:migrate
pnpm start:collector
```

Setup preserves the existing collector token and writes random database credentials
to the ignored, owner-only `.env`. It leaves an existing active `DATABASE_URL`
unchanged. The local database listens only on `127.0.0.1:55432` and uses a named
Docker volume. `pnpm db:down` stops it without deleting the volume. Local development
uses `DATABASE_SSL=disable`; remote connections default to verified TLS. Configure
`DATABASE_CA_FILE` for a private certificate authority. URL query parameters are
rejected; configure TLS, pool and timeout options through the separate settings.

Migrations run explicitly and serialize concurrent migration processes using a
PostgreSQL advisory lock. Applied migration hashes must match the repository.
Collector startup checks database readiness and requires migrations to be applied.
Production mode requires PostgreSQL. Use a migration role with DDL permissions and
an application role with SELECT, INSERT and DELETE on `timemachine_incidents`.
The development Compose role owns the database and is not a production role policy.

## Persistence and retention

Incidents are stored as validated JSONB with indexed IDs, service, receipt time
and expiry. UUIDs are normalized. Retrying the same incident returns duplicate;
a different payload with an existing ID returns conflict without overwriting it.
Database errors never expose connection strings or raw database diagnostics in
HTTP responses. Pools and statements have bounded timeouts; shutdown closes pools.

`DATABASE_RETENTION_DAYS` defaults to 30 and is measured from receipt. Expired
incidents are immediately hidden from lookup. Retries do not extend expiry.
Physical removal is explicit:

```sh
pnpm db:prune
```

Each run removes at most 1,000 expired incidents. Schedule it and repeat for larger
backlogs. Retention does not erase backups. Define encrypted backups and exercise
restore separately; Docker volumes persist locally but are not backups.

## Verify it yourself

Run the collector and `pnpm smoke:collector`. Save an incident ID from the collector
log, restart the collector, then request `/v1/incidents/<id>` using the same bearer
token. It should still return the incident. The SDK example works unchanged.

```sh
pnpm test:storage
```

This integration suite requires `TEST_DATABASE_URL` pointing at a dedicated test
server with CREATE DATABASE permission. It creates a uniquely named temporary
database, checks persistence, concurrent retries, conflicts, retention and migration
history, then drops only its own database. It never derives a test URL from
`DATABASE_URL`. Local setup supplies a test URL; CI uses a disposable service.
