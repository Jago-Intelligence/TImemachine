# HTTP dependency recording for Express

The automatic recorder observes native global fetch with approved policy rules; Axios
requires an instance adapter. This guide also describes optional explicit timeline and
fixture helpers. Use [dependency adapters](dependency-adapters.md) for current client
scope and [failed-request recording](failed-request-recording.md) for policy-based evidence.

## Show dependency calls on failed requests

Install the Express middleware before routes. Wrap each dependency client once with reviewed constant labels:

```ts
const tm = createExpressInstrumentation(sdk);
app.use(tm.middleware);
const inventoryFetch = tm.fetch('inventory', 'lookup');

app.post('/checkout', async (req, res, next) => {
  try {
    const response = await inventoryFetch(inventoryUrl);
    if (!response.ok) throw new Error('Inventory unavailable');
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});
app.use(tm.errorHandler);
// Add your application's final error responder here.
```

Request context follows asynchronous work. Each failed incident includes dependency start offset, duration and success/failure, bounded to 100 calls. Successful application requests remain unrecorded. This timeline helper adds metadata only. Approved body evidence is a separate policy
feature; raw credentials and unrestricted headers/exception messages are not included. Fetch timing ends at response headers, not full body consumption. Aborted or non-2xx dependencies are failures. Calls completing after the application response are omitted.

## Create reviewed response fixtures

Use a separate recorder per request or controlled test scenario, injected into one dependency operation. Provide an explicit projection of safe response fields:

```ts
const recording = createFetchRecording({
  fetch: inventoryFetch,
  project: async (response) => {
    const body = (await response.json()) as { available: boolean };
    return {
      status: response.status,
      body: JSON.stringify({ available: body.available === true }),
    };
  },
});
const response = await recording.fetch(inventoryUrl);
const fixtures = recording.snapshot();
```

Import createFetchRecording and createFetchReplay from @timemachine/sdk-node. Snapshots contain at most 100 responses of 16 KiB each, without URLs or headers. Projections are developer code: review them before persisting snapshots. Never include tokens, passwords or customer data. Projection failure preserves the original response but invalidates the snapshot; network errors and pending calls also invalidate it. Projected headers, streaming behavior and transport errors are not reproduced in this first version.

## Replay without external HTTP

Inside a registered Express scenario, inject the replay client into the same dependency operation:

```ts
const dependency = createFetchReplay(fixtures);
const app = createApp({ inventoryFetch: dependency.fetch });
// After exercising the app and checking its business result:
dependency.assertComplete();
```

The client consumes fixtures in invocation order, never calls the network, rejects extra calls and detects unused responses. Each dependency operation needs its own recorder/client. It does not validate URL or request-body equivalence; register a controlled scenario with explicit request and business assertions. Fixtures are not automatically uploaded with incidents or added to the replay registry yet: include reviewed snapshots in your registered scenario build. See [Express replay integration](custom-express-replay.md).

These explicit fixture snapshots are distinct from automatic policy-based occurrence
recordings. [Automatic replay](automatic-replay.md) promotes eligible complete occurrences
after a matching runner is registered; neither mechanism reconstructs arbitrary traffic.
