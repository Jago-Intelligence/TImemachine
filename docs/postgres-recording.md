# PostgreSQL dependency recording and replay

This adapter observes the developer application's pg 8 query methods. It is separate
from the collector's PostgreSQL incident-storage adapter.

The automatic Node launcher patches pg Pool.query and Client.query before app startup.
Pool-to-Client delegation is counted once. Successful API requests remain unpersisted;
failed incidents contain approved query snapshots and dependency timeline entries.

## Configure approved reads

Add this optional property to your recording policy:

```json
{
  "postgres": [
    {
      "id": "zone-rate",
      "text": "SELECT rate_per_km, currency FROM delivery_zones WHERE zone_code = $1",
      "parameterFields": ["zoneCode"],
      "rowFields": ["rate_per_km", "currency"]
    }
  ]
}
```

This is a policy fragment. Keep the existing request, HTTP dependencies and build
settings. Include zoneCode in the incoming route's selected bodyFields.

Each parameter must equal its corresponding explicitly approved parsed request field.
Unbound parameters are omitted and disable generation. SQL text stays in local policy;
incidents contain a SHA-256 normalized-query fingerprint, selected parameters, selected
row fields, row count and safe error code. Connection strings, credentials, SQL error
messages/details and unselected columns are never stored by this adapter.

Supported reads include explicit column lists, DISTINCT, unquoted schema-qualified
names, column/table aliases, INNER/LEFT/RIGHT/FULL joins with ON conditions,
parameterized comparisons (=, !=, <>, <, >, <=, >=), AND/OR with parentheses,
IN/NOT IN parameter lists, IS NULL/IS NOT NULL, multi-column ORDER BY with
ASC/DESC and NULLS FIRST/LAST, and LIMIT/OFFSET (parameters or bounded integers).
For example:

```sql
SELECT z.rate_per_km AS rate, r.currency
FROM public.delivery_zones z
LEFT JOIN regions r ON z.region_id = r.id
WHERE z.zone_code = $1 AND z.rate_per_km >= $2
ORDER BY z.rate_per_km DESC
LIMIT $3 OFFSET $4
```

Approve this exact query in `postgres[].text`, bind its four values through
`parameterFields` in order, and allow the returned alias `rate` and `currency`
in `rowFields`. Multiple approved lookups are recorded in invocation order.
Existing simple-query fingerprints are unchanged. Query case and repeated whitespace
are normalized; punctuation spacing and query structure must still match the policy.

This is a bounded SELECT grammar, not a general SQL parser. It rejects wildcards,
quoted identifiers, string literals, functions/aggregates, casts, arithmetic,
subqueries/CTEs, UNION, GROUP BY, cross joins, comments, semicolons, locks,
transactions and writes. Queries are limited to 4096 characters, 512 tokens,
eight joins and eight nested predicate groups. Unrecognized calls pass through
unchanged and mark recording incomplete. Result and parameter privacy limits remain
unchanged; larger read support does not increase retained row counts or payload sizes.

Supported calls use the native promise API: query(text, values) or query({text, values}).
Callbacks, streams, custom Promise implementations and pg-native are outside this
first adapter. It does not promise ORM coverage.

## Isolated replay

Use this function as the create callback of your registered scenario; adapt the
route and success assertion to your application:

```ts
async function createRecordedApp(recording, dependencies) {
  if (!recording || !dependencies) throw new Error('Recording required');
  return {
    handler: createApp({ database: dependencies.postgres }),
    request: { path: '/delivery/zone-quote' },
    assert: ({ response, body }) => response.status === 200 && body.quote.fee === 20,
  };
}
```

The supplied client offers query() and returns recorded rows, rowCount, SELECT command
and field names. It never opens a connection. Unexpected/changed SQL or parameters,
extra queries and unused queries fail replay even if app code catches the mismatch.

Safe matched SQLSTATE/connection-code errors are reproduced as an Error carrying code.
Driver-specific error classes, constraint/detail text, OIDs and other rich field
metadata are not recreated. An app that relies on them requires a richer fixture.
Recorded errors remain errors until a controlled scenario specifically models a
dependency change; restoring the live database does not change a saved error fixture.

This reproduces a read's observed result, not an entire database snapshot. Changed queries are rejected by this recorded-read adapter. Writes and transactions
use the separately reviewed [synthetic PostgreSQL mode](synthetic-postgres-replay.md);
arbitrary production-state or migration reconstruction is not supported.

## Bounds and safety

At most 10 queries per request, 20 rows/columns per query, 20 scalar parameters and
4 KiB per query snapshot. Longer strings, nested values, dates/buffers, omitted fields,
unknown error codes and unfinished queries remain partial. Shared incident/replay
payload limits still apply. Review selected fields: a harmless-looking column name
does not guarantee its values contain no customer data.

Read results are copied without modifying original application results. Capture does
not block unapproved queries in the real application. The replay client does reject
them, with Docker network isolation as the outer boundary.

## Validate your application scenario

Use a staging route whose selected inputs match approved read parameters. Trigger a
representative failure, inspect the retained query fingerprints and projected rows, and
replay that occurrence with the matching trusted build. After correcting code, build and
deploy the update and verify the original occurrence's business result. Do not point
replay at the live database. See [Express setup](express-setup.md).

## Writes and transaction scenarios

For APIs that change data, use the separate opt-in
[synthetic PostgreSQL replay mode](synthetic-postgres-replay.md). It runs real SQL in a
fresh local sandbox initialized with reviewed test fixtures; it does not record or
reconstruct production write state. Recorded reads remain available for other routes.
