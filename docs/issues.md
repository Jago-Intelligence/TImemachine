# Grouped issues

The dashboard groups repeated failures into issues. Each issue shows its retained
occurrence count, first and last observed failure times, service, environment and
HTTP route when present. Open it to browse individual captures, then open an
occurrence for its request ID, timeline, source locations and replay history.

## Workspace use

Open the dashboard's Issues page to filter groups by service, text, status and UTC
last-seen dates. Open a group for its retained occurrences, then an occurrence for
request evidence and replay history. Use individual project access in account mode.

Administrators apply storage migrations before upgrading the collector/dashboard.
Application developers install/configure the SDK separately:
[Express integration](express-setup.md) and [workspace access](workspace-access.md).

## Grouping rules

Identity version 1 uses these exact fields:

- Service name and environment.
- HTTP method and route template, or empty values for a non-HTTP capture.
- Failure code, error type and failure source.
- First captured source file and line, when available.

Request IDs, correlation IDs, timestamps, durations, source columns, release
versions, replay eligibility and fixture inputs do not affect grouping. Missing
source locations are distinct from captured locations. A changed source line can
create a new issue even if the error code stays the same. This deterministic rule
groups similar evidence; it does not prove all members have the same root cause.

Counts include distinct active incident IDs. A retry with the same incident ID
and identical contents remains one occurrence. A different request resulting in
a new incident ID adds one. Existing immutable-incident conflict rules still apply.

First/last seen use producer-provided `occurredAt`, not ingestion time. Counts and
times cover only retained captures and can decrease/change as captures expire.
They are not lifetime totals or unique-user counts. Group metadata shows the most
recent occurrence's application version; older occurrences retain their own
versions. Replay always runs an individual occurrence's fixture, not an entire
issue.

## Authenticated collector API

- `GET /v1/issues?limit=25&service=my-api` lists groups, newest last-seen first.
- `GET /v1/issues/:id?limit=25` returns an issue and a page of occurrences.
- Follow `nextCursor` using the same service filter for groups, or the same issue
  for occurrence pages. Cursors cannot be reused across these views.
- `GET /v1/incidents/:id` and the existing incident/replay endpoints still work.

All issue endpoints require the same bearer authentication as incident reads.
Limits are 1–100 with a default of 25. Service filtering uses an exact service
name. Live pagination is not a fixed snapshot; incoming captures can reorder
groups while browsing. Refresh the latest page to see current results.

## Storage behavior

A fingerprint is stored atomically with each PostgreSQL incident and indexed for
occurrence lookup. Counts are derived from unexpired rows, avoiding duplicate
increment races or stale counters after retention. PostgreSQL aggregates groups
before pagination, so counts are not limited to one page of incident records.
Memory storage follows the same identity and retention rules.

Issue listing aggregates retained records; it is not a precomputed analytics
rollup. Large retention windows may require a future maintained aggregation design.
Legacy fingerprint backfill runs transactionally with the normal migration process
and can take time on a large existing database.

Focused tests cover identity separation, retries, pagination scope and retention.
`pnpm test:storage` also verifies PostgreSQL grouping, restart persistence and
migration-fingerprint parity against an isolated integration-test database.

## Resolution and reopening

Issues start open. A passing replay does not automatically resolve an issue. After a
current-build verification passes its declared business assertions, the occurrence
page offers Mark issue resolved. The decision stores its timestamp, incident, replay
run and artifact ID as evidence. A status-code-only target is not sufficient.

Each newly stored occurrence advances an issue revision. The replay remembers the
revision at its start; resolution rejects proof from an older revision. Duplicate
transport retries do not advance the revision or reopen an issue. A genuinely new
occurrence with the same fingerprint automatically reopens it and keeps the previous
resolution snapshot. Source-location or other fingerprint changes may form a different
issue instead. This is not proof of deployment or coverage of every request.

Lifecycle state is durable in PostgreSQL through migration 0004_issue_resolution.
Apply migrations before upgrading the collector/dashboard. Memory
storage reserves 512 additional bytes per entry for bounded lifecycle metadata.
Expired groups disappear from listings; explicit pruning removes orphaned state.
Resolution snapshots can outlive their referenced occurrence's retention period,
so the original incident link may no longer be available after expiry.

Authenticated API: POST /v1/issues/:id/resolve with incidentId, runId and revision.
The dashboard requires a signed session, same-origin request and a bounded JSON body;
collector credentials stay server-side. Current revision and verification proof are
validated in storage; PostgreSQL row locks preserve reopening during concurrent writes.

## Search and filters

The issue list supports combined text search, exact service, open/resolved status
and a UTC last-seen range. Search is a case-insensitive literal substring across
issue ID, failure code/name, HTTP method/route, service and environment. It does not
search request bodies, database values or credentials. SQL wildcard characters have
no special meaning.

The dashboard's dates include both selected calendar days in UTC. API from is
inclusive and to exclusive, both millisecond-precision UTC ISO timestamps. Dates
filter the latest retained occurrence of each issue, rather than individual historical
occurrences; counts and first-seen metadata still cover all retained captures.
Search is bounded to 128 characters. Invalid dates, reversed ranges and unsupported
statuses are rejected. Pagination cursors are bound to all filters and cannot be reused
with changed filters. Clear/apply starts a new page; refresh and older-page links retain
the selected filters. Filtering runs before pagination in both storage adapters.
