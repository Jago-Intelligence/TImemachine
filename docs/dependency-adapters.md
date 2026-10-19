# Dependency adapters

Record approved dependency evidence alongside an Express request failure, then inject
controlled clients when replaying the saved scenario. These adapters extend failure
investigation; they are not a general database backup or a full network recorder.

> **Availability:** npm examples describe the intended workflow after publication.
> The SDK and replay packages are currently unpublished private packages. See
> [integration availability](integrations/README.md#availability).

## Choose an adapter

| Application dependency         | Capture integration                          | Supported replay scope                                                     |
| ------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------- |
| Native Node.js `fetch`         | Recorder preload and approved HTTP rules     | Bounded approved request/response evidence                                 |
| Axios                          | Wrap an Axios instance with `adapters.axios` | Recorded HTTP fixtures through an isolated Axios adapter                   |
| PostgreSQL `pg` reads          | Recorder preload and approved query rules    | Supported bounded parameterized SELECT results                             |
| PostgreSQL writes/transactions | Reviewed synthetic PostgreSQL scenario       | Fresh test database and declared database assertions, not production state |
| mysql2 promise clients         | `adapters.mysql(poolOrConnection)`           | Approved parameterized `query` / `execute` SELECT reads                    |
| MongoDB collections            | `adapters.mongodb(collection, name)`         | Approved `findOne` with scalar filters and an explicit projection          |
| BullMQ queues                  | `adapters.bullmq(queue, name)`               | Approved `add` submission acknowledgment, not worker execution             |

The SDK does not install these application clients or their servers for you. Keep using
your own dependency packages and connection lifecycle. MySQL/MongoDB/BullMQ adapter
clients and Axios instances require explicit wrapping; installing the SDK alone does
not instrument every library.

These are **application dependency adapters**. The TimeMachine collector's durable
incident store is PostgreSQL, and its alert-delivery outbox is separate from your
application's BullMQ queues.

## Install and start recording

After the npm release:

```sh
npm install --save-exact @timemachine/sdk-node
npx timemachine init --service my-api --entry server.js
```

Configure the shared collector URL and private project ingestion token, then start the
backend through `timemachine record` or the automatic Node preload. See
[production Express setup](express-setup.md). The preload must run before your client
wrapping code calls `automaticClientAdapters()`.

## Wrap existing clients once

Use your application's real instances, then pass the wrapped clients to its service
code. For example, in `src/dependencies.js`:

```js
import axios from 'axios';
import { automaticClientAdapters } from '@timemachine/sdk-node';

export function instrumentDependencies({ mysqlPool, mongoDb, notificationQueue }) {
  const adapters = automaticClientAdapters();
  const http = axios.create();
  const restoreAxios = adapters.axios(http, axios.getAdapter);

  return {
    http,
    database: adapters.mysql(mysqlPool),
    products: adapters.mongodb(mongoDb.collection('products'), 'products'),
    jobs: adapters.bullmq(notificationQueue, 'notifications'),
    restoreAxios,
  };
}
```

Pass a mysql2 **promise** pool or connection, a MongoDB database instance, and the
BullMQ queue your application already owns. Use the returned instances in your
request handlers. Wrapping preserves application results and errors during capture;
selected evidence is retained only according to policy.

Call `restoreAxios()` when removing its instrumentation, after relevant work has
finished. TimeMachine does not close your live database connections or application
queue for you.

If you use manual Express instrumentation instead of the preload, obtain these helpers
from your `createExpressInstrumentation(...)` instance: `instrumentation.clients.mysql`,
`instrumentation.clients.mongodb`, `instrumentation.clients.bullmq` and
`instrumentation.axios`. Those are instrumentation helpers, not methods on the raw SDK
client. Use one request-capture integration per process to avoid duplicates.

## Approve inputs and results

Recording is opt-in. Approve the request fields first; database/queue input values must
match the selected request fields. This complete policy illustrates three supported
operations for a product-check route:

```json
{
  "id": "my-api-v1",
  "requests": [
    {
      "method": "POST",
      "route": "/api/check-product",
      "bodyFields": ["sku"]
    }
  ],
  "dependencies": [],
  "postgres": [],
  "operations": [
    {
      "id": "product-price",
      "kind": "mysql",
      "operation": "execute",
      "selector": "SELECT price FROM products WHERE sku = ?",
      "inputFields": ["sku"],
      "resultFields": ["price"]
    },
    {
      "id": "product-stock",
      "kind": "mongodb",
      "operation": "findOne",
      "selector": "products",
      "inputFields": ["sku"],
      "resultFields": ["stock"]
    },
    {
      "id": "send-notification",
      "kind": "bullmq",
      "operation": "add",
      "selector": "notifications/send",
      "inputFields": ["sku"],
      "resultFields": ["jobId"]
    }
  ]
}
```

Save it in `timemachine/recording-policy.json` after adapting it to your real service.
The build command supplies the artifact identity through your project configuration;
you do not need to invent an image ID for basic recording.

Within a request using the wrapped instances:

```js
const [rows] = await database.execute('SELECT price FROM products WHERE sku = ?', [
  request.body.sku,
]);

const product = await products.findOne(
  { sku: request.body.sku },
  { projection: { _id: 0, stock: 1 } },
);

const job = await jobs.add('send', { sku: request.body.sku });
```

For MySQL, parameter order follows `inputFields`; do not embed variable values into SQL.
For MongoDB, project only approved fields and explicitly exclude `_id`. For BullMQ,
`notifications/send` means queue name `notifications` plus job name `send`. The recorded
`jobId` is a submission acknowledgment, not evidence that a worker processed the job.

Selectors are normalized where supported and hashed before incident storage. Approved
scalar values remain evidence and may still contain sensitive business data: hashing a
selector does not anonymize its inputs/results. Sensitive field names are rejected, but
you must review the actual contents and avoid unrestricted customer data.

### HTTP rules for fetch and Axios

Axios uses the same reviewed HTTP dependency rules as native fetch. Add an entry to
`dependencies` in your existing policy:

```json
{
  "id": "pricing-service",
  "method": "GET",
  "origin": "https://pricing.company.com",
  "route": "/rate",
  "responseFields": ["rate", "currency"]
}
```

This is a rule fragment, not a complete policy. Use your actual dependency origin and
route. Request-body approval remains separate. See
[HTTP dependency recording](http-dependency-recording.md) for headers, partial results
and response limits, and [PostgreSQL recording](postgres-recording.md) for `pg` queries.

## Inject controlled clients during replay

Never construct production database or queue connections inside the replay app factory.
Use the recorded clients supplied as the second argument to the scenario's `create`
function. Native fetch is replaced by the runner for supported recorded HTTP scenarios;
Axios needs the supplied `axiosAdapter`.

The following example assumes your own `createApp` accepts these dependency names and
its `/api/check-product` route returns `{ price, stock }`. Adapt both the dependency
interface and assertions to your real application:

```js
import axios from 'axios';
import { defineExpressReplay, runExpressReplay } from '@timemachine/replay';
import { createApp } from '../src/app.js';

await runExpressReplay(
  defineExpressReplay([
    {
      contract: {
        inputMode: 'recorded-http',
        service: 'my-api',
        profile: 'product-check-v1',
        scenarioVersion: 'v1',
        method: 'POST',
        route: '/api/check-product',
        failureCode: 'HTTP_500',
        target: {
          statusCode: 200,
          errorCode: null,
          outcome: 'scenario-assertions-passed',
        },
      },
      async create(recording, dependencies) {
        if (!recording || !dependencies) throw new Error('Recorded evidence required');
        const expectedPrice = recording.operations?.find(
          (operation) => operation.id === 'product-price',
        )?.rows[0]?.price;
        const expectedStock = recording.operations?.find(
          (operation) => operation.id === 'product-stock',
        )?.rows[0]?.stock;

        return {
          handler: createApp({
            database: dependencies.mysql,
            http: axios.create({ adapter: dependencies.axiosAdapter }),
            products: dependencies.mongodb.collection('products'),
            jobs: dependencies.queues.queue('notifications'),
          }),
          request: { path: '/api/check-product' },
          assert({ response, body }) {
            const submitted = dependencies.queues.submittedJobs();
            return (
              response.status === 200 &&
              typeof expectedPrice === 'number' &&
              typeof expectedStock === 'number' &&
              body?.price === expectedPrice &&
              body?.stock === expectedStock &&
              submitted.length === 1 &&
              submitted[0].queue === 'notifications' &&
              submitted[0].name === 'send' &&
              submitted[0].data.sku === recording.request.body.sku
            );
          },
        };
      },
    },
  ]),
);
```

Set the failure code to match the captured scenario. In this input mode, the runner uses
the approved captured request body; it is not sent to live production dependencies.
Assertions must return boolean `true`. The supplied clients validate fingerprints,
selected inputs, projections and complete fixture consumption. Changed, missing or extra
calls fail verification even if application code catches the dependency error.

After publication, install `@timemachine/replay`, review build files and run
`npx timemachine replay build`. Deploy the image and registry to the shared replay host.
See [Express replay setup](express-setup.md#add-isolated-replay) for the complete build,
deployment and verification flow.

## Current limits

| Adapter        | Deliberately limited or unsupported behavior                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Axios          | Flat JSON/text evidence; no binary/stream payloads, redirects, per-request adapter overrides or custom transport behavior. Replay errors expose compatible fields, not an actual `AxiosError` instance. |
| mysql2 promise | Restricted SELECT grammar, bounded scalar parameters and flat rows. No writes, transactions, callback API, streams, connection lifecycle or complete driver metadata.                                   |
| MongoDB        | Scalar `findOne` filter and reviewed projection only. No cursors, aggregation, nested documents, ObjectIds, operators or writes.                                                                        |
| BullMQ         | Submission acknowledgment only. No Redis access in replay, worker processing, delays, job options, retries, deduplication, schedulers or complete Job API.                                              |
| PostgreSQL     | Bounded documented query subset. Writes/transactions require separately reviewed synthetic fixtures, not recorded production state.                                                                     |

Operation recordings are bounded to 20 calls and 20 scalar fields/rows per call, with
additional payload limits. Unsupported or oversized calls through wrapped clients still
run in the application but mark recording incomplete. Dependency calls through unwrapped
clients are not captured; you must identify those before claiming replay coverage.

Do not assume unsupported network calls become safe mocks. A partial recording remains
useful for investigation, but cannot establish complete reproduction.

## Production validation

Automated tests cover supported adapter contracts with client doubles, and Axios capture
is tested with its real transform pipeline. That does not establish compatibility with
every deployed database version, connection configuration or queue behavior.

Before rollout, validate the complete capture/replay flow against your actual clients in
staging. Confirm request-field matching, projections, queue submission semantics,
failure handling and meaningful success assertions. Keep live dependency credentials
out of replay images and fixtures.

A replay pass verifies the declared scenario with controlled recorded results. It does
not prove a production database is healthy, that a real notification was sent, or that a
BullMQ worker successfully completed a job.
