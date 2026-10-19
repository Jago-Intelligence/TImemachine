# Dashboard

The Next.js dashboard is the browser-facing workspace for investigating issues, reviewing
occurrences, running configured replays and managing team access and alerts. It calls the
collector API server-side and never connects directly to PostgreSQL.

## Access your workspace

Open the HTTPS dashboard URL supplied by your administrator and use your individual
email/password in account mode. The collector URL is an API endpoint, not the dashboard.
Use the configured dashboard origin exactly; different hostnames have different cookies.

Legacy shared-password mode remains available, but does not provide project-specific
user access. See [workspace access](workspace-access.md) and
[self-hosted setup](self-hosted-setup.md) for infrastructure provisioning.

## Browse and investigate

The home page groups repeated failures into issues. Filter by exact service name, literal
text search, open/resolved status and a UTC last-seen date range. Pagination preserves
filters. Counts reflect retained captures, not lifetime totals or unique users.

Open an issue for its individual occurrences. The newest is emphasized; older captures
retain their own build, timestamp and replay history. Open an occurrence to inspect:

- Method, route, HTTP status, UTC error time and elapsed duration.
- Request/correlation IDs, runtime and application version.
- Execution timeline and available project-relative source locations.
- Approved request/dependency evidence and supported cause explanations.
- Replay availability, history, comparison and verification checks.

Cause explanations identify supported evidence patterns; they do not edit code or prove
an arbitrary root cause. The UI never supplements captures with live production data.
Empty, expired, unauthorized or unavailable views have explicit states.

## Replay and verification

An eligible occurrence can replay its original trusted image and verify the current
build against its declared response and business assertions. Incomplete evidence,
unregistered images, missing Docker images and unreachable Docker have different states.
Optional registry recovery shows backup/restoration status and verifies image identity.

Older observations may show checks as Not reported; that is not a pass. Reproducing a
500 and passing a declared success target are distinct outcomes. A verified scenario
can be used as evidence for the explicit Mark issue resolved action. A new occurrence
can reopen the issue. See [replay](replay.md) and [issue lifecycle](issues.md).

## Workspace and Alerts

Workspace sections organize projects, people, ingestion tokens and account security.
Administrators create accounts, assign developers to services and rotate/revoke tokens.
Developers can investigate and replay their assigned projects. Password changes, resets
and account disablement invalidate persisted sessions in account mode.

Administrators configure provider settings on **Alerts**. Empty secret fields preserve
existing values; configured secrets are not returned to the browser. Test buttons send
real notifications to the selected configured destination. See [alerts](alerts.md).

## Authentication and deployment

Cookies are signed, HttpOnly, SameSite=Strict, Secure for HTTPS origins and expire after
eight hours. Account mode resolves the collector's persisted session and current role
instead of treating possession of an old signed cookie as permanent access. Legacy
cookies have the separate shared-password limitations documented in workspace access.

Collector credentials remain server-side; do not expose them through `NEXT_PUBLIC_`
variables. Protected pages/API routes require a session, mutating routes enforce origin
checks, and collector calls are bounded, uncached and reject redirects.

| Setting                     | Infrastructure role                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `DASHBOARD_ORIGIN`          | Exact browser origin                                                                               |
| `DASHBOARD_SESSION_SECRET`  | Private cookie-signing secret                                                                      |
| `TIMEMACHINE_COLLECTOR_URL` | Server-side collector URL                                                                          |
| `TIMEMACHINE_AUTH_TOKEN`    | Infrastructure control-plane credential; account sessions use separate credentials for data access |
| `WORKSPACE_AUTH_MODE`       | `accounts` or legacy shared access                                                                 |
| `WORKSPACE_ADMIN_EMAIL`     | Initial sign-in hint; account bootstrap belongs to the collector                                   |
| `DASHBOARD_PASSWORD`        | Legacy shared-password sign-in, not account-mode passwords                                         |

Dashboard service deployment is separate from npm SDK installation. Current repository
commands are source-operated launch helpers with loopback defaults; remote deployment
needs explicit binding/routing, HTTPS, secrets and durable storage. See
[self-hosting](self-hosting.md).

## Contributor verification

The development check is `pnpm check`. Dashboard smoke uses synthetic credentials and
isolated loopback services; production validation still requires representative staging
scenarios, project access and your real proxy/origin configuration.
