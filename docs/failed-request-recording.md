# Approved request and dependency evidence

The Express recorder can attach reviewed parsed request fields and supported dependency
results to failed incidents. Evidence appears with the occurrence's timeline and source
locations. No per-route `tm.error()` calls are required.

## Configure the policy

After installing the released SDK, initialize the project and edit
`timemachine/recording-policy.json`. Packages are currently unpublished; see
[availability](integrations/README.md#availability).

```json
{
  "id": "my-api-v1",
  "requests": [{ "method": "POST", "route": "/api/convert", "bodyFields": ["amount"] }],
  "dependencies": [
    {
      "id": "exchange-rate",
      "method": "GET",
      "origin": "https://rates.company.com",
      "route": "/rate",
      "responseFields": ["rate", "currency"]
    }
  ],
  "postgres": []
}
```

Use your real route and dependency origin. This selects the amount and flat rate/currency
response fields, not unrestricted request or response bodies. The automatic startup
loads the policy through project configuration. Restart the backend after policy changes.

See [Express code usage](express-setup.md#use-it-in-application-code) and
[dependency adapters](dependency-adapters.md) for database, queue and Axios integration.

## Privacy and bounds

- Selected body values are flat scalars: boolean, finite number, null or bounded string.
  At most 20 fields are selected per body; common sensitive field names are rejected.
- Allowed names do not guarantee safe contents. Review actual values and business data.
  The collector also sanitizes and rejects known credential patterns.
- Incoming body evidence comes from parsed Express `request.body` after handling. A
  handler that mutates it can change what is recorded; the raw byte stream is not saved.
- Path/query values, cookies and unrestricted credential headers are not stored.
  Supported HTTP matching uses the configured method, origin and literal pathname.
- Fetch response projection is asynchronous and bounded to 8 KiB with a 200 ms deadline.
  Unsupported, large, invalid or timed-out projections are partial.
- At most 20 projected HTTP dependency responses are retained. Unmatched/pending calls
  and overflow mark the recording incomplete. Calls after the app response are omitted.
- Capture waits at most 250 ms for projections without delaying the application's
  already-sent HTTP response. Transport errors retain a safe marker, not raw details.
- SDK timeline limits and adapter-specific operation limits also apply.

## Reproduction limits

Complete supported evidence can become a replay candidate when the matching app runner
and build are registered. Partial captures remain useful for investigation. Missing
inputs are not guessed or reconstructed from production systems.

Policy changes cannot fill an old capture retroactively. Register the matching trusted
scenario, restart with its artifact ID and capture a new representative failure.
[Automatic replay](automatic-replay.md) explains promotion and supported routes.
