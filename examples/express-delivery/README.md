# Express delivery fee example

This is a contributor test application, not the installation path for an npm consumer.
Use [Express production integration](../../docs/express-setup.md) for your own backend.

A small Express backend and plain HTML page for testing automatic capture and replay.
The backend calls a separate pricing HTTP service. It initially reads the wrong rate
field, producing a real code failure. No orders, payments or customer accounts are involved. The optional zone-lookup flow
uses its own PostgreSQL database; incident storage uses a separate PostgreSQL database.

## Start everything

From the repository root, with Docker Desktop running:

```bash
pnpm demo
```

This command prepares the collector database and dashboard credentials, builds the
app's replay image, registers it and starts the collector, backend, pricing service
and dashboard. It supplies recording policy/build settings to the child app without
overwriting your private .env replay configuration. The first Docker build may take
a few minutes; later runs reuse build layers.

Open **http://127.0.0.1:4322**. Open TimeMachine with the page's button and sign in
using your account-mode administrator email/password from private infrastructure settings
(legacy mode uses DASHBOARD_PASSWORD).

If an old process occupies 4318, 4321, 4322 or 4330, stop it in its terminal first.
The launcher reports occupied ports and never kills unrelated processes.
Custom collector/dashboard ports are supported; the example uses fixed 4322/4330.

## Test the flow

1. Leave distance at 10 km and click **Calculate delivery fee**.
   Expect HTTP 500. The page shows its actual response and request ID.
2. Open TimeMachine. Filter delivery-api if needed, then open the latest occurrence.
   The recording should include distanceKm=10 and pricing ratePerKm=2, currency=USD.
   Click **Replay failure**: the captured build should reproduce HTTP 500.
3. Edit src/app.js:
   `const RATE_FIELD = 'rate';` → `const RATE_FIELD = 'ratePerKm';`
4. Stop pnpm demo with Ctrl+C and run pnpm demo again. It rebuilds/registers the new
   image and keeps the captured image trusted. Reload the HTML page; its build label
   should now say Fixed.
5. Open the **same original occurrence**, expand Verify changed code and click
   **Verify application fix**. Expect HTTP 200 and a verified $20 fee using the same
   saved distance and dependency response.
6. Calculate again in the live HTML page: expect a successful $20 quote.
   The original incident remains a record of the original failure.

Use **Test invalid input (400)** and **Check backend (200)** to confirm expected
validation and successful requests do not create incidents. Request history on the
HTML page is temporary and clears on reload. Try other distances before the fix to
generate separate recorded occurrences.

## Files

- src/app.js: real route, validation, price lookup and fee calculation.
- src/main.js: local API and synthetic pricing service.
- src/replay-runner.js: registered app factory and positive fee assertion.
- recording-policy.json: allowlisted distance/rate/currency fields.
- public/index.html: ordinary same-origin fetch requests, with credentials omitted.
- ../../infra/delivery-replay.Dockerfile: isolated replay build.

The policy explicitly ignores common browser transport headers for this public test
route. Its pricing policy also ignores TimeMachine's own x-request-id response header.
Cookies and authorization still make a recording partial. Business headers
must not be ignored for an app whose behavior depends on them.

The pricing service is a controlled stand-in for a real external provider. Replay
uses its captured JSON response and does not contact the running service. This example
demonstrates one public API flow; it does not prove all backend cases or production
readiness. Keep intentional demo bug/fix changes separate from a release; production users should
configure their own application factory and assertions.

## Understand the cause

New failures also show Cause investigation. The approved source snapshot links the
wrong rate field to the recorded pricing response, so TimeMachine can explain why
.toFixed() encounters undefined. See [cause explanations](../../docs/cause-explanations.md).
Old incidents without source evidence cannot receive this explanation retroactively.

## PostgreSQL flow

Select PostgreSQL zone lookup on the page. The demo now also prepares a separate
delivery PostgreSQL database, independent of collector storage. LOCAL costs $2/km;
EXPRESS costs $4/km. The new database code intentionally reads rate instead of
rate_per_km, so you can capture and replay a genuine database-result/code mismatch.

Fix DATABASE_RATE_FIELD in src/database-app.js to rate_per_km, restart pnpm demo and
verify the original occurrence. The existing HTTP flow is unchanged.
See [PostgreSQL recording](../../docs/postgres-recording.md) for scope and limitations.

## Registration transaction

The same HTML page now includes Register a test user. POST /users/register inserts a
synthetic user and audit entry in one transaction. Its initial acton column typo triggers
rollback. The registered synthetic PostgreSQL replay scenario creates fresh empty tables,
checks failure rollback, and verifies a fixed build returns 201 with exactly one user and
linked audit entry. Fix AUDIT_COLUMN to action in src/registration-app.js, restart pnpm demo,
and verify the original occurrence. See
[transaction replay documentation](../../docs/synthetic-postgres-replay.md).
