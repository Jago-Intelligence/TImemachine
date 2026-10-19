# Automatic replay generation for recorded Express requests

Complete supported HTTP recordings can now become replay candidates at collector
ingestion. Each failure supplies its own captured request and dependency responses:
developers no longer hand-write input fixtures for each occurrence.

A developer still registers a trusted Docker app runner once per route and defines
its success assertion. Traffic alone cannot identify an app factory or the intended
business result. This is not zero-configuration replay of arbitrary applications.

## Supported recordings

- Node SDK incident with a completed HTTP 5xx response.
- A literal route such as /checkout; no path parameters, authentication/cookies or
  incoming queries. GET/HEAD bodies are unsupported.
- All required parsed JSON body fields selected without omissions.
- All supported recorded HTTP dependencies matched by the policy, with complete selected flat
  JSON response fields. Their configured origin is recorded for exact mock matching.
- No outgoing query values, request bodies, credential headers, redirects, transport
  errors, truncated/pending calls or partial response bodies.
- Recorded artifact ID must equal the owning app's registered current image at
  initial ingestion. Only one registered recorded-input contract may match the route,
  method and failure code.
- Recorded payload at most 60 KiB. Existing incident size/retention limits apply.

Dependencies are matched by origin, method and pathname, in invocation order within
an endpoint. Extra or unused calls fail replay; there is no real-network fallback.
Docker's network-none sandbox remains the outer network restriction.

Unsupported recordings remain investigable. Replay information explains incomplete
data, unsupported routes, missing app registration or unavailable artifacts. Update
the policy/runner and capture a new occurrence; older incomplete inputs are not filled
in by guessing.

## Register an app runner once

Use defineExpressReplay with inputMode: recorded-http:

```ts
const adapter = defineExpressReplay([
  {
    contract: {
      inputMode: 'recorded-http',
      service: 'my-api',
      profile: 'checkout-v1',
      scenarioVersion: 'v1',
      method: 'POST',
      route: '/checkout',
      failureCode: 'HTTP_500',
      target: { statusCode: 200, errorCode: null, outcome: 'scenario-assertions-passed' },
    },
    async create(recording) {
      if (!recording) throw new Error('Recorded input required');
      return {
        handler: createAppWithControlledTestState(),
        request: { path: '/checkout' },
        assert: ({ response, body }) =>
          response.status === 200 &&
          body.totalCents === recording.request.body.quantity * 1500,
      };
    },
  },
]);
await runExpressReplay(adapter);
```

The runner substitutes recorded request inputs for the placeholder request, installs
recorded fetch responses while running the app, and requires the assertion to return
true. Application code and assertions execute only inside the trusted sandbox.
Do not import a production server entrypoint, credentials or live database connections.

Use HTTP_500 for automatic 500 capture (or the matching HTTP status code). The SDK
records HTTP status-derived codes automatically, not arbitrary JSON error codes.

Build with `npx timemachine replay build`; the command updates the project artifact ID.
Deploy the image and registry metadata to the shared replay host. The recording policy
loads from project configuration. Do not point
the recorder at a different code revision than its registered image.

App factories that snapshot global fetch during module import need adjustment:
the runner installs mocks before create(), after modules have loaded. Use global fetch
at invocation time. Concurrent recorded replays in one Node process are rejected.

## Current limitations

Parsed incoming body is observed after handling. If the app mutates it, saved fields
can differ from the original request; reproduction can fail. We do not intercept the
incoming byte stream. Unapproved request/response headers, arbitrary production database state, external
side effects and transport-error fixtures are not recreated. Supported recorded database
operations and reviewed synthetic transactions use their documented adapters.
Use controlled app state and a route whose behavior depends only on the selected
inputs and JSON dependency responses.

The existing standalone replay:check command does not have recorded occurrence
inputs. Use dashboard occurrence replay for recorded-input contracts; standalone CI
export of generated tests is a later step.

Validate your own registered build and representative occurrence in staging. Unit/contract
tests do not establish compatibility with every application or deployment.
