# TypeScript integration

The SDK also supports `createTimeMachineFromConfig()` and the generated JSON connection/private credential files. See [Project configuration](../project-configuration.md). Existing environment-based initialization remains supported.

Use TimeMachine in a TypeScript backend running Node.js 24. The SDK supports explicit
failure capture and native HTTP wrapping. Express middleware and automatic recording are available from this repository.
See the [availability note](README.md#availability): npm installation becomes available after publication.

## Install and configure

Follow [the integration overview](README.md) for npm installation, shared workspace
configuration, and private project credentials. For Express, begin with the
[production setup and application code examples](../express-setup.md). The explicit
SDK examples below also support environment-based configuration.
Set `"type": "module"` in your backend's `package.json`.

For an Express application, install Express if you do not already use it:

```sh
npm install express@5
```

For TypeScript, install the compiler and type definitions:

```sh
npm install --save-dev typescript @types/node@24 @types/express@5
```

Use this `tsconfig.json` for a new ESM application, or merge these settings with your
existing build configuration:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": "src",
    "outDir": "dist",
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

The SDK ships type declarations; there is no separate TimeMachine types package.

## Express: initialize once

Create `src/timemachine.ts` in your backend:

```ts
import { createTimeMachine, createExpressInstrumentation } from '@timemachine/sdk-node';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const tm = createTimeMachine({
  collectorUrl: requiredEnv('TIMEMACHINE_COLLECTOR_URL'),
  token: requiredEnv('TIMEMACHINE_AUTH_TOKEN'),
  service: {
    name: 'my-api',
    version: '1.0.0',
    environment: 'development',
  },
  language: 'typescript',
  sourceRoot: process.cwd(),
});

export const requests = createExpressInstrumentation(tm);
```

Use your application's service name, version and environment. Invalid or missing
configuration fails SDK initialization. `sourceRoot` is optional; omit it to disable
source-location capture. Keep credentials in your environment, not in source code.

## Express: register middleware

In your existing Express entry point, such as `src/app.ts`:

```ts
import express, { type Request, type Response, type NextFunction } from 'express';
import { requests } from './timemachine.js';

const app = express();

app.use(requests.middleware);
app.use(express.json());

// Register your existing API routes and routers here.

app.use(requests.errorHandler);
app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Request failed' });
});

const server = app.listen(3000);
```

The request middleware goes before parsers and routes. The error observer goes after
routes and before your final responder. It forwards the error; your app still
controls its response. No per-route wrapper is required. Ensure async failures reach
Express error handling using the mechanism provided by your Express version.

Compile and run your backend, or use your existing build/start commands:

```sh
npx tsc
node --env-file=.env --enable-source-maps dist/app.js
```

NodeNext uses `.js` import paths in TypeScript source because those are the emitted
file names. `--enable-source-maps` can map captured locations back to TypeScript
when source maps and source files are available. Otherwise frames can refer to
compiled JavaScript.

The middleware captures 5xx responses even when no exception is thrown, and captures
prematurely closed responses. GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, CONNECT
and TRACE are supported when those requests reach Express. Other HTTP protocols or
upgrade handling outside Express require their own integration.

## Optional 4xx capture

Replace the instrumentation initialization with:

```ts
export const requests = createExpressInstrumentation(tm, {
  captureClientErrors: true,
});
```

This includes validation, authentication and not-found responses with 4xx status.
By default they are excluded, as are successful responses.

## Mounted routers

The SDK reads route definitions, not raw URLs. For a router with a dynamic mount,
register a reviewed full template for the applicable endpoint:

```ts
router.patch('/profile', requests.route('/users/:id/profile'), updateProfileHandler);
```

`updateProfileHandler` represents your existing handler. Do not provide actual
customer IDs, query strings or secrets as the template. Unsupported patterns fall
back to `/:unmatched`; mount parameters are not inferred from raw `baseUrl` values.

## Capture a caught error explicitly

For application errors outside an HTTP request:

```ts
try {
  await runYourOperation();
} catch (error) {
  tm.captureException(error, { code: 'APPLICATION_OPERATION_FAILED' });
  // Keep your application's existing recovery or error propagation here.
}
```

`runYourOperation` represents your own application operation. Use a reviewed stable
code, not an error message. The return value is `{ queued: true, incidentId }` or
`{ queued: false, reason }`; queuing is not confirmation of collector delivery.

For a caught error inside an Express handler:

```ts
requests.captureException(req, res, error, {
  code: 'PROFILE_UPDATE_FAILED',
});
```

This attaches request context and suppresses the automatic duplicate after a
successful queue operation. Use it in a scope where `req`, `res` and `error` are
available. Keep your own response handling. A manually captured error before a
response finishes may not contain a completed response status.

## Native Node.js HTTP

For a backend that uses `node:http` directly, use the supported handler wrapper:

```ts
import { createServer } from 'node:http';
import { tm } from './timemachine.js';

const server = createServer(
  tm.wrapHttpHandler('/profile', async (req, res) => {
    // Put your existing handler logic here.
    res.end('OK');
  }),
);

server.listen(3000);
```

For native HTTP only, remove `createExpressInstrumentation` and `requests` from
`src/timemachine.ts`. On a fresh GitHub checkout, also omit `sourceRoot` because that option is part of
the local source-location implementation.

The wrapper handles thrown or rejected handler errors and
completed 5xx responses. A handler exception returns a generic 500 when possible;
if headers are already sent, the connection is closed. Use a wrapper per reviewed
route template in your existing routing logic, not one misleading template for
all endpoints. This wrapper is for native HTTP handlers, not Express middleware.

## Graceful shutdown and delivery

After stopping new requests and allowing existing requests to finish:

```ts
await tm.close({ timeoutMs: 5000 });
```

You can incorporate this into your server's shutdown path:

```ts
process.once('SIGTERM', () => {
  server.close(() => {
    void tm.close({ timeoutMs: 5000 }).then((drained) => {
      if (!drained) process.exitCode = 1;
    });
  });
});
```

Adapt the signal handling to your application's existing lifecycle and bound how
long active requests can take. Close database pools and other resources as usual.
Use `tm.getStats()` to inspect queue health, and `await tm.flush({ timeoutMs: 5000 })`
to wait for delivery without closing the SDK. Do not expose credentials or SDK
configuration through a public diagnostics endpoint.

## Verify your integration

With your collector and backend running, trigger a known failure in one of your
local API routes. Open the dashboard and filter by `my-api` (or your configured
service name). Inspect method, route, UTC time, status, request ID and available
source locations. Check that a successful request does not create an incident.
Source locations identify the throw site, not automatically the root cause.

Capture alone does not enable replay. Each replay requires a supported safe fixture.
For delivery limits, troubleshooting and data exclusions, see the
[shared integration documentation](README.md#delivery-and-troubleshooting).
