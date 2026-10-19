# Self-hosting

A workspace needs the collector, dashboard and durable PostgreSQL storage. Installing
the npm SDK in a backend does not deploy these services. The platform is pre-release;
there are no published production collector images or distributed replay-worker fleet.

## Deployment boundaries

Run the collector and dashboard behind HTTPS routing with their distinct configured
origins. Keep PostgreSQL private and use a dedicated application role, reviewed TLS
settings and persistent backups. Start from [workspace setup](self-hosted-setup.md).

Use account mode for individual users and service projects. Keep infrastructure
control-plane, session-signing and notification-encryption secrets server-side. Backend
applications receive project ingestion tokens, not storage/database credentials.
[Workspace access](workspace-access.md) documents scope and legacy-mode differences.

The dashboard calls the collector API; it does not connect to PostgreSQL. Alert delivery
is an in-process collector worker over a durable outbox. Redis/BullMQ is not a required
platform service. Deployments must provide process supervision, logging and appropriate
shared abuse controls where multiple service instances are used.

## Replay host

The collector needs controlled access to a Docker daemon to run trusted replay images.
Treat that access as privileged host access. The daemon may be on the same host or a
securely configured remote Docker host; the application and replay containers must not
receive its socket or credentials.

Deploy trusted registry JSON and matching images to the replay host. Optional private
image-registry backup uses Docker authentication and immutable digests. Containers have
no external network, host mounts or production credentials and use resource/time limits.
Docker alone is insufficient for arbitrary hostile multi-tenant code.

## Operations

Use liveness and readiness separately; readiness requires usable storage. Apply request
limits, timeouts and rate limiting at the proxy and service layers. Retain controlled
operational metadata without unrestricted incident payloads in logs.

Back up PostgreSQL and the encryption/signing infrastructure secrets needed for recovery.
Apply reviewed migrations before deploying code that needs new tables. Preserve replay
images while retained incidents need them; external garbage collection can break replay.
Follow [storage](storage.md), [collector](collector.md), [dashboard](dashboard.md) and
[replay](replay.md) for exact settings and limitations.

## Staging acceptance

- Test denied anonymous access, project isolation and credential rotation.
- Exercise migrations, data/secret restore and retention with disposable data.
- Validate approved fields with representative application inputs.
- Test health, collector outages, request draining and termination.
- Verify isolated replay and real registry backup/recovery.
- Confirm actual alert provider delivery without exposing credentials.

There is no AI account required for the core workflow. Deployment hardening and package
release status should not be inferred from a successful demo.

## Security boundary for replay

The built-in Docker replay executor remains restricted to loopback development:
`NODE_ENV=production` with replay configured, or a non-loopback collector binding
with replay configured, fails validation. Keep this guard enabled. Capturing and
investigating incidents in production does not require enabling replay there.
Run reviewed reproductions on a separate development or staging host. A shared
production replay worker is not implemented yet.

Docker access grants control over the Docker host. Use a dedicated VM with no
production workloads, cloud instance role, customer secrets or production mounts.
Prefer a rootless daemon owned by a dedicated operating-system user. Do not mount
a production Docker socket into the collector or enable Docker's unauthenticated
TCP API. Explicit remote `DOCKER_HOST` endpoints require SSH or TLS verification.
Also review the active Docker context: the environment check cannot validate an
externally configured context or provision host isolation for you.

Replay containers use a non-root UID, no network, a read-only root filesystem,
private IPC, dropped capabilities, no privilege escalation, disabled core dumps,
and CPU, memory, process, open-file and temporary-storage limits. Only reviewed,
registered application images are trusted. These controls do not establish a
hostile multi-tenant code execution service. Keep Docker, the host kernel and
container base images patched.

## Authentication and outbound traffic

Use accounts mode for a shared workspace. Account sign-in budgets are saved in
workspace storage, so collectors sharing PostgreSQL also share the per-account
20-attempt/minute budget. The dashboard no longer applies its legacy shared login
budget to account sign-ins. Legacy shared-password mode retains its single-process
budget and is intended for a private local workspace, not a public team deployment.
An attacker can still target one account's budget; put an independently managed
per-client connection/request limit at the TLS ingress. Do not trust arbitrary
`X-Forwarded-For` headers. Collector request limits still use the directly connected
peer; behind a proxy, that peer is the proxy. Size this safety limit for aggregate
traffic, and enforce client-specific limits at the ingress. Database failure denies
account authentication rather than bypassing the persistent budget.

Production webhook delivery resolves every hostname, rejects non-public and mixed
public/private results, pins the checked address for the TLS connection, validates
the certificate and refuses redirects. Both queued delivery and the Alerts test
button use this transport. Development/test transports permit local receivers.
Private internal webhooks are intentionally unsupported by the production transport.
SMTP is administrator-configured and separate; restrict SMTP egress to your approved
mail relay. Apply an outbound firewall as a second boundary, including denial of
cloud metadata and production private networks. Application-level address checks
cannot identify a public address routed internally by your own network.

Dashboard pages use a fresh nonce for scripts, including the initial theme script
and Next.js bootstrap scripts. Production policy excludes `unsafe-eval` and
`unsafe-inline` for scripts. Inline styles remain allowed for the current UI.
Use HTTPS and set the canonical dashboard origin correctly for secure cookies.
