# Collector

The Fastify collector supports authenticated incident ingestion and lookup,
public health probes, pluggable storage and graceful shutdown. PostgreSQL and the Node.js
SDK, dashboard and isolated Docker replay runner are available. Replay jobs are
serialized in the collector; a separate distributed worker is not implemented. Use the reviewed recording and sanitization boundaries before sending production evidence.

## Source-operated administrator startup

From the repository root, install dependencies and prepare configuration:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
openssl rand -hex 32
```

Copy the generated random value into `.env` as `TIMEMACHINE_AUTH_TOKEN=<value>`.
Remove the leading comment marker on that setting. Use a real random token;
do not use the example placeholder. Keep `.env` private and out of Git. Keep Unix file permissions restricted: `chmod 600 .env`.

```sh
pnpm start:collector
```

The command builds the collector and its workspace dependencies, loads the root
`.env` if present, and starts on `127.0.0.1:4318`. Existing environment variables
take precedence over `.env`. A token is required for every startup, even loopback.
`NODE_ENV=production` requires `STORAGE_DRIVER=postgres`. See [durable storage](storage.md).

In another terminal, from the same repository root:

```sh
pnpm smoke:collector
```

This submits the synthetic Node.js fixture and verifies public health, authenticated
lookup, unauthorized rejection and unsupported schema rejection. It loads the same
root `.env`, uses its `PORT`, and connects to loopback only. It does not print the
token or incident contents. A repeat run is idempotent. The fixture remains in
memory until expiry or shutdown. Stop the collector with Ctrl+C.

The smoke command intentionally requires a ready service; it will fail when storage
is at capacity or a rate limit is exceeded. Use a fresh development process and the
default limits for this example.

## Account-mode authentication

The startup instructions above describe source operation, not npm SDK deployment. For
shared workspaces, use [account mode](workspace-access.md): project tokens authenticate
SDK ingestion, workspace sessions authenticate project-authorized reads/replay, and the
infrastructure control-plane token is reserved for dashboard login. Legacy mode retains
shared bearer behavior. Do not use infrastructure credentials in an application SDK.

## HTTP API

| Method and route        | Authentication | Result                                                   |
| ----------------------- | -------------- | -------------------------------------------------------- |
| `GET /health/live`      | Public         | `200 {"status":"ok"}` while process can serve            |
| `GET /health/ready`     | Public         | `200 {"status":"ready"}` or `503 {"status":"not-ready"}` |
| `POST /v1/incidents`    | Bearer token   | `201` on creation; `200` on matching retry               |
| `GET /v1/incidents`     | Bearer token   | `200` with paginated incident summaries                  |
| `GET /v1/incidents/:id` | Bearer token   | `200` with sanitized incident; `404` when absent         |

Public health responses contain no storage details, versions or credentials. Readiness
fails during shutdown, on store errors or when the configured entry/byte capacity is
exhausted. Matching retries can still succeed at capacity. Liveness is independent
of storage readiness.

Ingestion requires `Authorization: Bearer <token>` and `Content-Type: application/json`.
The optional charset must be UTF-8; invalid UTF-8 bytes are rejected and compressed
bodies are not supported. Request
bodies are limited to 256 KiB before JSON parsing and validated with the core parser.
Authentication runs before body parsing. Token comparison uses fixed-size SHA-256
digests and constant-time comparison. One shared token grants access to all incidents;
this milestone does not implement tenants, users, sessions or per-incident permissions.

Incident IDs are canonicalized to lowercase UUIDs. Lookup accepts either UUID case.
The incident-ID idempotency check compares sanitized contract data. Changed free text
that the sanitization policy omits does not create a conflict. Changing stored data
under an existing ID returns `409 INCIDENT_CONFLICT`.

Successful ingestion returns:

```json
{
  "apiVersion": 1,
  "incidentId": "8b372947-b5ba-4b5f-8b84-3e53e686f014",
  "status": "accepted"
}
```

The `Location` header points to the authenticated lookup route. Lookup returns
`{"apiVersion":1,"incident":...}`. No work is queued and no replay runs on ingestion.

## Errors and correlation

API errors use a constant message and stable code:

```json
{
  "apiVersion": 1,
  "error": {
    "code": "INVALID_INCIDENT",
    "message": "The incident does not match the supported contract.",
    "requestId": "generated-request-uuid",
    "correlationId": "validated-correlation-id",
    "fields": ["failure.summary"]
  }
}
```

Field paths appear only for core validation errors. Responses never include submitted
values, arbitrary unknown field names, raw errors or stack traces. Authentication
failures return `401`, malformed JSON `400`, invalid contracts or versions `422`,
oversized input `413`, unsupported media `415`, conflicts `409`, exhausted or
unavailable storage `503`, rate limits `429`, and unexpected errors `500`.

Every application response includes `X-Request-Id` and `X-Correlation-Id`, as well as
`Cache-Control: no-store`. The service generates request IDs and ignores incoming
`X-Request-Id`. `X-Correlation-Id` is optional and must be 1–128 characters, starting
with a letter or digit, then letters, digits, `.`, `_`, `:`, or `-`. Invalid correlation
headers produce `400`; missing values use the generated request ID. Incident capture
correlation IDs are stored separately from the collector HTTP request context.

Early router failures such as malformed URL escapes return the same sanitized
error envelope with a generated correlation ID; oversized route parameters return
`414`. These failures occur before normal hooks and do not consume the rate budget.
Node's HTTP parser may reject malformed transport headers before Fastify can create
an application request; those responses cannot carry the application error envelope.

## Sanitization and logging

The collector always replaces failure summaries with a constant explanation,
normalizes custom error names to `CapturedError` and removes stack function names.
Built-in JavaScript error names and project-relative frame locations are retained.
Any field containing the configured collector token causes rejection before storage.

Core rejects raw payloads, headers, URLs with query strings and raw stack fields.
Remaining metadata, route templates, logical dependency names and reviewed codes
must still be sanitized by producers. An ASCII identifier can contain a secret;
structural validation and this conservative policy cannot recognize every secret
or personal detail. No AI provider is used for sanitization.

Framework request logging is disabled with Fastify's log controller. Explicit Pino
logs contain request/correlation IDs, route templates, status, duration, operation
codes and incident IDs. They exclude raw URLs, headers, payloads and error details.

## Storage, limits and shutdown

The memory adapter retains at most 1,000 incidents and 16 MiB of serialized UTF-8
data, with one-hour retention by default. These are serialized data limits, not an
exact process-memory limit. Expiry is based on collector receipt time, not producer
timestamps. Records are pruned on access and readiness checks; no timer is needed.
Retries do not extend retention. Capacity exhaustion rejects new incidents instead
of silently evicting accepted ones. All incidents disappear on restart.

Limits are validated from `.env.example`. Rate limiting defaults to 60 requests per
client IP per minute across API routes, including authentication failures and unknown
routes. Health probes are exempt. Budgets are local to each process. Forwarded IP
headers are ignored: behind a proxy, its address will share one budget. Trusted-proxy
and distributed-limiter configuration will require a separate deployment decision.

The HTTP request timeout is 15 seconds, connection inactivity timeout is 20 seconds,
and keep-alive timeout is 5 seconds. These are transport controls, not deadlines for
database operations. The PostgreSQL adapter supplies connection, statement and query
timeouts; see [storage configuration](storage.md).

`SIGINT` and `SIGTERM` mark the service draining, stop accepting work, close idle
connections and wait for active requests before closing the store. Repeated shutdown
calls share one promise. `SHUTDOWN_TIMEOUT_MS` defaults to 10 seconds; exceeding it
forces remaining sockets closed and the entrypoint exits with a failure status.
Resource cleanup runs through Fastify's `onClose` lifecycle. See the
[Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/) for
connection draining and close semantics.

## Verification

```sh
pnpm check
```

Turbo builds the collector before its tests. Tests cover API authentication, validation,
size and rate limits, sanitization, duplicate/conflict behavior, store limits and expiry,
health failures, safe logging, real HTTP request draining and shutdown deadlines.
Process tests execute the compiled entrypoint and smoke script, then verify clean
exit on both termination signals and failure on unsupported startup configuration.

## List incidents

`GET /v1/incidents` requires the same bearer token as ingestion and lookup.
It returns `{ "apiVersion": 1, "items": [...], "nextCursor": null }`.
Each item contains `id`, `occurredAt`, `service`, `failure.name`, `failure.code`
and `replayStatus`. Fetch `/v1/incidents/:id` for the full sanitized timeline.

Query parameters:

- `limit`: integer from 1 to 100; defaults to 25.
- `service`: optional exact service name.
- `cursor`: use the previous response's `nextCursor` to fetch the next page.

Keep the same service filter when following a cursor. `nextCursor: null` means
there are no more results. Unknown parameters, repeated parameters and malformed
cursors return `400 INVALID_LIST_QUERY`. Missing credentials return `401` first.

Results are ordered by occurrence time descending, then UUID descending. The
cursor uses that pair, so tied timestamps paginate consistently. New incidents
before the cursor do not shift subsequent pages; refresh the first page to see
them. This is not a snapshot: late arrivals and expiry can change results while
paging. Expired incidents are excluded. There is no total count or offset scan.
Cursors are navigation values, not credentials. One token still grants access to
all services. Responses use `Cache-Control: no-store`; rate limits also apply.

```sh
curl 'http://127.0.0.1:4318/v1/incidents?limit=10&service=example-orders' \
  -H 'Authorization: Bearer <your-token>'
```

Run `pnpm db:migrate` to add list indexes, then restart the collector.

Issue alerts can be enabled for new and reopened issues. See [webhook and Slack configuration](alerts.md). Apply migrations before restarting with updated storage code.
