# Node.js SDK

`@timemachine/sdk-node` captures explicit application failures and supported Node.js
HTTP handler failures, then sends sanitized incident v1 records to the collector.
Packages are currently unpublished. After release, install the SDK in your own Node.js
24 application through npm; see [integration availability](integrations/README.md).

The SDK supports explicit capture, native HTTP wrapping, Express instrumentation and
automatic Node startup recording. Approved native fetch responses and pg 8 reads can
be recorded; opted-in transaction scenarios use reviewed synthetic replay fixtures.
Prefer `createTimeMachineFromConfig()` for shared JSON/private-credential setup.
See [Express setup](express-setup.md), [automatic recording](automatic-recording.md),
[PostgreSQL recording](postgres-recording.md) and [isolated replay](replay.md).
The collector and dashboard run separately from your application.

## Explicit capture

Application code can use the package like this:

```ts
import { createTimeMachine } from '@timemachine/sdk-node';

const token = process.env.TIMEMACHINE_AUTH_TOKEN;
if (!token) throw new Error('TimeMachine collector token is required');

const timemachine = createTimeMachine({
  collectorUrl: 'https://collector.company.com',
  token,
  service: { name: 'my-api', version: '1.0.0', environment: 'production' },
  language: 'typescript',
});

try {
  // Perform your application operation here.
} catch (error) {
  const capture = timemachine.captureException(error, {
    code: 'ORDER_CREATION_FAILED',
    requestId: 'reviewed-request-id',
    correlationId: 'reviewed-correlation-id',
  });
  if (!capture.queued) {
    console.warn('Incident capture dropped:', capture.reason);
  }
  // Handle the original error as your app normally does.
}

const drained = await timemachine.close({ timeoutMs: 5000 });
console.info('Incident delivery settled:', { drained, ...timemachine.getStats() });
```

`captureException` returns immediately with `{queued:true, incidentId}` or
`{queued:false, reason}`. Reasons are `closed`, `queue-full` or `invalid-context`.
Queued means accepted into memory, not delivered or persisted. Invalid capture
context is dropped without throwing into the application. Invalid configuration
throws at client creation, with value-free errors.

Use `code` for a reviewed application identifier, never an error message, query,
user ID or credential. Request and correlation IDs are optional; missing values
are generated locally. SDK incident correlation is sent as the collector request's
`X-Correlation-Id`. Service metadata and all explicit context must meet the core
contract and be reviewed for sensitive data.

Explicit HTTP context may include `method`, a sanitized `route` template, an
optional `statusCode` and optional integer `durationMs`. The timeline contains
request metadata, an error code and optional response metadata. It never contains
raw URLs, headers, bodies or query strings. Non-HTTP capture uses v1's
`unhandled-error` category; capture itself installs no process error handlers.

## Node.js HTTP wrapper

```ts
import { createServer } from 'node:http';

const handler = timemachine.wrapHttpHandler('/orders/:orderId', async (req, res) => {
  // Handle a request using your application's existing code.
  res.end('ok');
});

const server = createServer(handler);
server.listen(3000, '127.0.0.1');
```

The route template is supplied at registration; the SDK never derives it from a
request URL. This helper captures synchronous exceptions, rejected handler promises
and completed responses with 5xx status codes. Successful responses pass through.
Each request gets independent generated correlation IDs; headers are not inspected.

On a handler exception before headers are sent, the wrapper owns error handling
and sends a constant 500 response. After headers have been sent it destroys the
incomplete response. An exception after a finished response is captured once
without rewriting that response. This is an opt-in Node.js server helper, not
middleware for Fastify, Express or Next.js. Use explicit capture in an existing
framework error handler to preserve its behavior. Detached async work, process
crashes and client disconnects without handler exceptions are not automatically
captured.

## Sanitization

Error messages, stacks, causes, custom error names and arbitrary properties are
never transmitted. Known native error categories are retained; other thrown values
become `CapturedError`. Failure summaries are constant. Optional project-relative
source frames and approved source-access evidence are structured and bounded; raw
source text is not transmitted. The collector applies its own sanitization policy.

Known collector credentials in service metadata are rejected at configuration time;
capture metadata containing that token is dropped before transport. Other reviewed
metadata can still contain secrets if supplied incorrectly. Structural validation
is not a general secret detector. Basic capture works independently of your database;
recording dependencies requires a supported adapter and reviewed policy.

Replay candidates require a complete supported recording and registered app runner,
or an explicitly matched reviewed fixture. Incomplete captures remain investigable.

## Delivery and shutdown

| Option             | Default                         | Bounds       |
| ------------------ | ------------------------------- | ------------ |
| `maxQueueSize`     | 100 incidents                   | 1–1,000      |
| `maxQueueBytes`    | 1 MiB serialized UTF-8          | 1 KiB–16 MiB |
| `requestTimeoutMs` | 2 seconds                       | 10–30,000 ms |
| `maxRetries`       | 2 retries after initial attempt | 0–3          |
| `retryDelayMs`     | 250 ms initial delay            | 1–5,000 ms   |

In-flight work counts against both queue limits. One worker preserves enqueue
order. New captures are dropped when full; accepted work is not silently evicted.
There is no disk spool, batching or durable delivery guarantee. The queue is lost
if the application exits without draining or crashes.

Network failures, request timeouts, HTTP 408, 429 and 5xx responses are retried.
Other rejections, including authentication and validation failures, are permanent.
Retries use the same incident ID and serialized body so collector idempotency can
handle an acknowledgement lost in transit. Backoff doubles up to five seconds.
Numeric `Retry-After` seconds are honored with a five-second cap; date-form headers
fall back to backoff. Redirects are refused. Remote endpoints require HTTPS unless
`allowInsecureHttp: true` is explicitly set for a trusted development network.
URL credentials, query strings and fragments are rejected. Bearer tokens must be
32–256 visible ASCII characters. Collector acknowledgements must match the incident
ID and API version; malformed acknowledgements are permanent failures and
response bodies are limited to 4 KiB.

`flush({timeoutMs})` waits for the queue to drain, defaulting to five seconds. A
false result leaves delivery running. `close({timeoutMs})` first stops new capture;
after its deadline it aborts delivery and drops remaining work. Close is idempotent.
Timeouts must be integers from 1 to 60,000 ms. Neither method installs signal handlers
or exits the process: the application owns its shutdown lifecycle. Stop accepting
application requests before closing the SDK, as the example demonstrates.

A true flush or close result means drained, not that every incident was delivered.
Inspect `getStats()` for `delivered`, `failed`, `dropped`, `pending` and `pendingBytes`.
Statistics are immutable snapshots. Transport error details and credentials are
never logged by the SDK. Application and collector logging remain separate.

## Verification

`pnpm check` includes capture privacy tests, queue limits, retries, request and flush
timeouts, redirect refusal, stalled response bodies, HTTP wrapper behavior and real
application-to-collector integration. Integration tests use isolated ports and
synthetic credentials, and verify that collector rejection does not stop the app.

For a browser-based capture, replay and fix exercise, use the
[Express delivery example](../examples/express-delivery/README.md).

## Automatic Express failure capture

Register instrumentation before body parsers and routes, and register its error
observer before your final error responder:

```ts
import { createTimeMachine, createExpressInstrumentation } from '@timemachine/sdk-node';

const tm = createTimeMachine({
  collectorUrl: process.env.TIMEMACHINE_COLLECTOR_URL!,
  token: process.env.TIMEMACHINE_AUTH_TOKEN!,
  service: { name: 'my-api', version: '1.0.0', environment: 'development' },
});
const requests = createExpressInstrumentation(tm);
app.use(requests.middleware);
app.use(express.json());

app.put('/users/:id', async (req, res) => {
  // Your application code. Returned 5xx responses are captured too.
});

app.use(requests.errorHandler);
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Request failed' });
});
```

The middleware covers the standard HTTP methods GET, HEAD, POST, PUT, PATCH,
DELETE, OPTIONS, CONNECT and TRACE for requests that reach Express. It captures
completed 5xx responses and prematurely closed responses. Successful requests
and 4xx responses are excluded by default. Enable validation/authentication/not-found
failure capture with `createExpressInstrumentation(tm, { captureClientErrors: true })`.
The SDK's existing queue limits and delivery controls still apply; capture is
best effort and does not block the response.

Stored metadata contains method, a route template, status when completed, elapsed
time, and generated request/correlation IDs. The generated `x-request-id` response
header connects a customer report to the incident. Bodies, query strings, raw URLs,
headers, cookies, IP addresses and raw error messages are not collected. Files,
streams and multipart contents are not copied. Route definitions should themselves
contain no secrets. Unsupported route patterns use `/:unmatched`; mounted routers
can register a reviewed full template with `requests.route('/teams/:id/orders')`.
The observer forwards errors without replacing your application error handler.
Express 4 async handlers must still forward rejected promises to `next`; this
integration does not patch Express error propagation.

For an explicit application code or registered replay fixture, use
`requests.captureException(req, res, error, context)` in your error handler. This
shares request IDs and suppresses a second automatic incident after a successful
queue operation. Calling `tm.captureException` separately does not perform this
deduplication. Automatic capture alone does not enable replay: registered safe
fixtures are still required. See [the replay guide](replay.md).

This adapter instruments inbound Express requests. Outbound HTTP calls, database
operations, WebSocket messages, background jobs and other frameworks need separate
instrumentation; it does not claim to record every application operation.

## Locating failures

Incident details show method and route, response status, UTC error-observation time
with milliseconds, error offset from request start, response duration, and request
ID for looking up application logs. Express errors observed by the error middleware
retain their observation time even if the final responder takes longer. A failed
response without a thrown exception is observed at completion. These times describe
when the SDK observed the failure, not when an underlying dependency first broke.
Older captures retain their original timing metadata.

To include source locations, initialize the SDK with `sourceRoot: process.cwd()`
(or an absolute path to your application root). This is enabled in the Express demo.
Only validated file paths relative to that root, line and column are sent. Frames
outside the root and dependencies in node_modules are excluded; raw stack strings,
function names and error messages are not sent. Application-defined stack getters
are ignored. With compiled TypeScript, locations refer to the running JavaScript
unless the runtime provides mapped locations. Some thrown values and manually sent
5xx responses have no usable stack; the dashboard then says no locations were
captured. Stack capture is optional and disabled unless sourceRoot is configured.

## Replay your own application

Use a registered test scenario and the request-aware `requests.replay(fixture)`
middleware for an explicitly matched input case. See [the custom Express guide](custom-express-replay.md)
for image registration, controlled dependencies and business-result verification.

For request-scoped outbound fetch timelines and reviewed offline HTTP fixtures, see
[HTTP dependency recording](http-dependency-recording.md).

To start a Node app without per-route capture calls, see
[Automatic Node recording](automatic-recording.md).

For generating supported replay candidates from recorded failures, see
[Automatic replay](automatic-replay.md).
