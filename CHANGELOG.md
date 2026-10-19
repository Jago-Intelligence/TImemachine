# Changelog

## Unreleased

No public npm release has been published. The entries below describe source changes.

### Current application and workspace features

- Express automatic recording and configured isolated replay with business assertions.
- Approved fetch/Axios, PostgreSQL and selected mysql2/MongoDB/BullMQ dependency evidence.
- Issue grouping, search/date/status filtering, verified resolution and reopening.
- Workspace accounts, admin/developer roles, project access and ingestion-token rotation.
- Encrypted dashboard alert settings; Slack, email, Teams, Discord and webhook delivery.
- Replay build automation, preserved historical registrations and immutable backup/recovery.
- Refined sidebar/settings UI and npm-facing integration/deployment documentation.

### Foundation and earlier milestones

- Establish pnpm and Turborepo workspace tooling with strict TypeScript, ESLint,
  Prettier, Vitest and CI.
- Add validated server configuration and structured Pino logging packages.
- Document language adapter boundaries, incremental milestones, contributor
  practices and self-hosting security requirements.
- Add language-neutral incident schema v1 with bounded wire validation, typed
  timeline events, adapter capabilities and provisional Node.js replay eligibility.
- Add synthetic Node.js and Python contract fixtures and document strict schema
  compatibility and sanitization boundaries.
- Add a Fastify collector with bearer-authenticated incident ingestion and lookup,
  health checks, rate limits, conservative sanitization and graceful shutdown.
- Add bounded temporary incident storage, a local smoke command and collector
  operating instructions with HTTP and process lifecycle tests.
- Add a capture-only Node.js SDK with explicit failure capture, an HTTP handler
  wrapper, bounded delivery, retry limits, sanitization and timed flush/close.
- Add an instrumented HTTP example, SDK usage documentation and application-to-
  collector integration tests independent of application database choice.
- Add a database-independent incident store interface, PostgreSQL JSONB persistence,
  checked Drizzle migrations, expiry cleanup and connection lifecycle handling.
- Add private local database setup, a Compose volume and real PostgreSQL tests
  covering collector process restarts, retries, conflicts and retention.
- Add authenticated incident summaries with bounded cursor pagination, exact service
  filtering, expiry handling and PostgreSQL list indexes.
- Add a Next.js dashboard with workspace sign-in, service filters, cursor navigation,
  incident details, source locations and execution timelines.
- Keep collector credentials on the server; add signed expiring sessions, bounded
  login forms, origin checks and dashboard HTTP smoke coverage.
- Add an Express orders API with real PostgreSQL operations, explicit SDK capture,
  a separate application database and manual outage/recovery instructions.
- Add a one-command local demo launcher and short order, outage and recovery
  commands with owned-process shutdown and separate database handling.
