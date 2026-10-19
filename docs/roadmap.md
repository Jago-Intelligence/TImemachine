# Release roadmap

TimeMachine's core Express workflow is implemented: capture unexpected failures,
investigate approved evidence, replay supported scenarios, change code and verify the
same saved scenario. Feature scope and release validation are separate.

## Implemented

- Node.js SDK for JavaScript/TypeScript, Express 5 automatic capture and explicit APIs.
- Bounded recording/delivery, native fetch and documented dependency adapters.
- Fastify authentication, validation, health, rate limits and graceful shutdown.
- PostgreSQL incident storage, migrations, retention, grouping and issue lifecycle.
- Next.js investigation UI, search/date/status filters and verification comparisons.
- Individual accounts, admin/developer roles, project access and ingestion tokens.
- Encrypted settings and independently retried Slack, email, Teams, Discord/webhook alerts.
- Trusted Docker replay, app-factory assertions, synthetic PostgreSQL scenarios,
  historical registrations and optional immutable image backup/recovery.
- Project JSON configuration, setup/startup diagnostics and one-command replay builds.

See [architecture](architecture.md) for actual components and
[adapter limits](dependency-adapters.md) for operation-level support. There is no
separate distributed worker fleet, general AI patching service or regression-test
export package in the current implementation.

## First npm beta gate

Packages remain unpublished. Before releasing a versioned beta:

1. Finalize package names, scope permissions, publishable manifests and dependency order.
2. Validate clean installation and the full Express workflow from final package archives.
3. Exercise real private-registry backup/recovery and image identity checks.
4. Validate concurrent capture/replay, outages, bounded queues, shutdown and storage limits.
5. Review security, supported versions, release automation and migration/upgrade guidance.

An initial beta should promise only its tested Express/Node.js scope. It need not wait
for every language, ORM or queue adapter.

## Later work, not current promises

- Additional live-client integration coverage and supported adapter expansion.
- Broader framework/language SDKs after the current contract is stable.
- Automated replay artifact deployment and stronger remote execution management.
- SSO/MFA, invitation/password recovery flows and security audit records.
- Stronger isolation for hostile code and explicit multi-workspace tenancy design.
- Reviewed regression-test export where fixture completeness can be demonstrated.

Prioritize reliability and clear unsupported states before expanding product claims.
Contribution conventions and checks are in [development](development.md).
