# Express integration

Connect your Express backend to a shared TimeMachine workspace. Capture unexpected
request failures automatically, investigate their evidence, and verify supported
scenarios against an updated application build.

> **Package availability:** this guide describes the intended workflow after the npm
> release. `@timemachine/sdk-node` and `@timemachine/replay` are currently unpublished
> private packages. The installation commands below will become usable when they are
> released. For availability, see [installation](integrations/README.md).

## Before you install

You need:

- **Node.js 24 and Express 5** for the documented automatic integration.
- A running TimeMachine **collector and dashboard**, with durable PostgreSQL storage
  for a production workspace. Your workspace administrator deploys these separately.
- The HTTPS collector URL and a **project ingestion token**, created in
  **Dashboard → Workspace → Tokens**. The project's service name must match your SDK
  configuration.

The SDK does not deploy the workspace. Your backend sends evidence to the collector;
team members open the dashboard URL to investigate. Configure alert destinations in
**Dashboard → Alerts**, rather than putting Slack or email credentials in your app.

See [self-hosted workspace setup](self-hosted-setup.md) and
[workspace access](workspace-access.md).

## Install the SDK

After the package is published, run from your existing Express project's root:

```sh
npm install --save-exact @timemachine/sdk-node
npx timemachine init --service my-api --entry server.js
```

Keep the SDK in runtime dependencies. Commit your dependency lockfile and use `npm ci`
in deployment. For TypeScript, build your application and initialize with its compiled
entrypoint, for example `--entry dist/server.js`.

Initialization creates:

| File                                | Purpose                                                    | Commit to Git?         |
| ----------------------------------- | ---------------------------------------------------------- | ---------------------- |
| `timemachine/config.json`           | Collector URL, service identity and configuration paths    | Yes, after reviewing   |
| `timemachine/credentials.json`      | Private project ingestion token                            | **No**                 |
| `timemachine/recording-policy.json` | Approved request and dependency fields                     | Yes, after reviewing   |
| `timemachine/start.json`            | Node entrypoint and startup arguments                      | Yes                    |
| `timemachine/replay-runner.mjs`     | App-factory and assertion template for optional replay     | Yes, after configuring |
| `timemachine/replay.json`           | Approved replay build files and optional backup repository | Yes, after reviewing   |

It also creates a private-file ignore rule and setup notes. Existing application files,
`.env` files and npm scripts are preserved. Initialization refuses to overwrite an
existing `timemachine` directory. It does not start your backend or register a replay
build.

## Configure your backend

Edit `timemachine/config.json`:

```json
{
  "version": 1,
  "collectorUrl": "https://collector.company.com",
  "service": {
    "name": "my-api",
    "version": "1.0.0",
    "environment": "production"
  },
  "credentialsFile": "timemachine/credentials.json",
  "recordingPolicy": "timemachine/recording-policy.json",
  "replayRegistry": ".timemachine/replay-apps.json"
}
```

Use your actual collector URL. The dashboard URL is separate; it does not belong in
`collectorUrl`. Keep `service.name` stable across releases and set `service.version` to
identify the running application release.

Paste the project token into `timemachine/credentials.json`:

```json
{
  "authToken": "YOUR_PROJECT_INGESTION_TOKEN"
}
```

That value is a placeholder: use the full token displayed once when creating it.
Initialization restricts the file to its owner. If your deployment copies or mounts
it, retain those permissions:

```sh
chmod 600 timemachine/credentials.json
```

Alternatively, inject `TIMEMACHINE_AUTH_TOKEN` through your deployment's secret manager.
An empty generated credentials file can remain in place. Never bake the token into a
container image, commit it, or put it in public JSON configuration. The SDK validates
an existing credentials file even when environment overrides are supplied.

Configuration precedence is **process environment → project JSON/private credentials
→ optional legacy environment-file fallback**. No application `.env` edits are required.
Supported deployment overrides include `TIMEMACHINE_COLLECTOR_URL`,
`TIMEMACHINE_AUTH_TOKEN`, `TIMEMACHINE_SERVICE_NAME`, `TIMEMACHINE_SERVICE_VERSION`,
`TIMEMACHINE_ENVIRONMENT`, `TIMEMACHINE_RECORDING_POLICY`, and
`TIMEMACHINE_REPLAY_ARTIFACT_ID`. Remove stale artifact overrides when using the build
command's automatic JSON updates.

See [project configuration](project-configuration.md) for the complete format.

## Start your backend in production

Add a startup script to your application's `package.json`:

```json
{
  "scripts": {
    "start": "timemachine record"
  }
}
```

Merge this into your existing scripts. If you already have build or deployment steps,
keep them. Run from the project root so TimeMachine can find its configuration:

```sh
npx timemachine doctor
npm start
```

`record` starts the entrypoint saved in `timemachine/start.json` and installs recording
before your application loads Express. It does not build TypeScript, start the
collector, or start a database. Use your deployment platform's process supervision.

For an existing Node startup command, you can use the preload directly:

```sh
node --import=@timemachine/sdk-node/automatic dist/server.js
```

This also reads project configuration from the working directory. Use **one recording
integration** per process; do not combine the automatic preload with a second manual
Express instrumentation layer. Direct preload does not run the CLI's collector replay
readiness check, so validate setup separately with `doctor` and an end-to-end check.

### What gets captured

Automatic capture observes unexpected request failures across the Express app's routes,
including supported thrown/rejected errors and failed HTTP responses. You do not need
to put a capture call in every handler.

- Successful requests are not stored as incidents by default.
- Ordinary 4xx responses, such as invalid input or an incorrect password, are ignored
  by default.
- Captures include available method, route, status, UTC timing, correlation identifiers,
  timeline events and project source locations.
- Request bodies and dependency results require approved recording rules. Unsupported
  or omitted data can limit replay.

Capturing an error does not establish its root cause. Source locations identify where
an error occurred; supported cause explanations rely on additional evidence.

For errors outside observed requests, see the explicit `captureException` API in the
[Node SDK guide](node-sdk.md). Supported dependency adapters and their limits are listed
in [dependency adapters](dependency-adapters.md).

## Use it in application code

### Automatic capture: keep your Express routes normal

You do not need `tm.error()` in each route. Start the backend with the recording
launcher above, and keep your existing Express error handling.

For example, this API converts an amount using an HTTP pricing dependency. Separating
app creation from listening also makes the same application usable by a replay runner.

**`src/app.js`**

```js
import express from 'express';

async function getRate() {
  const response = await fetch('https://rates.company.com/rate');
  if (!response.ok) throw new Error('Pricing service unavailable');
  return response.json();
}

export function createApp({ pricing = { getRate } } = {}) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.post('/api/convert', async (request, response) => {
    const amount = request.body?.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return response.status(400).json({ error: { code: 'INVALID_AMOUNT' } });
    }

    const quote = await pricing.getRate();
    // Example expected dependency result: { rate: 0.9, currency: 'EUR' }.
    const rate = Number(quote.rate.toFixed(2));
    return response.json({
      converted: Math.round(amount * rate * 100) / 100,
      currency: quote.currency,
    });
  });

  // Express 5 forwards rejected async handlers here.
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    return response.status(500).json({
      error: { code: 'CONVERSION_FAILED', message: 'Unable to convert this amount.' },
    });
  });

  return app;
}
```

**`server.js`**

```js
import { createApp } from './src/app.js';

const app = createApp();
app.listen(Number(process.env.PORT ?? 3000));
```

These files use ES modules; set `"type": "module"` in your application's package.json,
or use the equivalent imports for your application's module setup. Replace the pricing
URL with your own service. The example retains the application's responsibility for
validation, error responses and production shutdown handling.

Start it with `npm start` using `"start": "timemachine record"`. TimeMachine reads
`timemachine/config.json` and the private credentials file; there is no SDK import
required in these route files.

| What happens                                                     | What TimeMachine does                              |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| Valid amount and usable rate → HTTP 200                          | Does not create a failure incident                 |
| Invalid amount → HTTP 400                                        | Ignores the expected client error by default       |
| Dependency outage or unexpected application exception → HTTP 500 | Captures the failed request and available evidence |

With the recording policy in the next section, approved `amount`, `rate` and `currency`
fields can be retained. A failure does not require an approved body to be investigated,
but replay needs complete supported inputs or a reviewed synthetic scenario.

A developer then opens the occurrence, investigates its source location and recorded
response, fixes the application, builds/registers the update and verifies the same
saved scenario. For this API, success assertions should check the converted amount and
currency as well as HTTP 200. Simply returning 200 from the error handler is not a fix.

### Explicit capture: errors outside a request

Use the SDK directly for a caught background-job error that automatic request capture
cannot observe. The explicit method is **`captureException`**, not `tm.error()`.

```js
import { createTimeMachineFromConfig } from '@timemachine/sdk-node';

const tm = createTimeMachineFromConfig();

export async function runReportJob(generateReport) {
  try {
    await generateReport();
    return { ok: true };
  } catch (error) {
    const result = tm.captureException(error, { code: 'REPORT_JOB_FAILED' });
    // result.queued means accepted into the SDK queue, not delivered to the collector.
    return { ok: false, captureQueued: result.queued };
  }
}

// At this worker's shutdown, after accepting no further jobs:
export async function closeMonitoring() {
  return tm.close({ timeoutMs: 2000 });
}
```

Pass your real job function to `runReportJob`. Its failure result lets your worker apply
its own retry or failure handling. The SDK does not run or retry the business job.
Call `closeMonitoring` from your worker's actual graceful-shutdown routine; defining it
alone does not install a shutdown hook. Do not close the SDK after each request or job.

Do not explicitly capture the same request error already observed by the automatic
integration. This example catches and handles the job error; rethrowing it into an
uncaught-exception path can result in another capture.

## Approve evidence for replay

The generated empty recording policy permits basic failure investigation. To replay
saved inputs, approve specific routes and safe fields. For example:

```json
{
  "id": "my-api-v1",
  "requests": [
    {
      "method": "POST",
      "route": "/api/convert",
      "bodyFields": ["amount"]
    }
  ],
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

Use routes and dependencies from your own backend. Approve only the evidence needed
for investigation and replay. Do not capture passwords, access tokens, cookies,
unrestricted customer data, or wildcard bodies. Partial recordings remain useful for
investigation but may require reviewed fixtures before replay is available.

For database rules, follow [PostgreSQL recording](postgres-recording.md) and the
[adapter guide](dependency-adapters.md). Capture support does not mean every database
operation or production state can be reproduced.

## Add isolated replay

Replay is optional and requires a trusted application build plus a developer-reviewed
scenario. After the packages are published:

```sh
npm install --save-exact @timemachine/replay
```

Keep it installed wherever your build and replay runner execute. Configure the generated
`timemachine/replay-runner.mjs` to:

1. Import your **app factory**, which creates the Express app without calling `listen()`
   or connecting to production services as an import side effect.
2. Inject supported recorded dependency clients or reviewed test fixtures.
3. Define the route, scenario profile, expected response and meaningful business
   assertions.

The template intentionally throws until configured. TimeMachine does not invent a
success assertion or rewrite your application code. See
[custom Express replay](custom-express-replay.md) and [replay](replay.md) for contracts
and supported dependency modes.

### Build a trusted replay image

Review `timemachine/replay.json`:

```json
{
  "version": 1,
  "runner": "timemachine/replay-runner.mjs",
  "files": ["package.json", "package-lock.json", "src", "timemachine/replay-runner.mjs"]
}
```

`files` is the explicit list sent to Docker. Include imported modules and assets; exclude
credentials, `.env` files and production secrets. If your package has a compilation
script, add `"buildScript": "build"` and make the runner import its compiled output.
The standard builder uses Node.js 24. Native dependencies or additional system packages
may require a custom image.

The builder supports npm lockfiles and pnpm lockfiles with a pinned
`packageManager` version. Local, workspace and monorepo dependencies require a custom
Docker build; they are not supported by this standalone build command.

With Docker available on the build machine:

```sh
npx timemachine replay build
```

The command builds the approved files, validates the scenario manifest, preserves
historical registrations, and updates `replayArtifactId` in `config.json` automatically.
Restart or redeploy the recorded backend with that configuration. Failed builds do not
advance its artifact ID.

### Deploy replay to the shared workspace

The backend, collector and replay host may be separate machines. Building an image on
a developer's computer does not deploy it to the shared workspace.

Deploy the generated registry JSON and matching image to the collector's replay host.
Configure the collector's `REPLAY_APPS_FILE` with that registry's path. It reloads valid
updates on incoming requests, normally within one second; changing the configured file
path requires a collector restart. Malformed updates retain the last valid registry.

For backup and automatic image recovery, add a repository to `replay.json`:

```json
{
  "backupRepository": "registry.company.com/team/my-api-replay"
}
```

Merge that field into the full replay configuration. Authenticate Docker with push
permissions on the build machine and pull permissions on the replay host, using your
registry's recommended credential mechanism. Keep credentials outside TimeMachine JSON.

The build command uploads the image and records its immutable digest. Deploy the updated
registry JSON separately. The replay host can recover a missing image from that backup
and verifies its image ID before running it. A failed configured backup does not advance
recorder configuration, although a local registration may already have been written.

Keep images and backups while retained incidents reference them. External Docker pruning
or registry garbage collection can still remove a required image; a rebuild cannot
recreate a deleted original build. See [historical retention and recovery](replay.md).

### Reproduce and verify

1. Capture an unexpected failure after its matching replay build is registered.
2. Open its occurrence in the dashboard and run **Replay failure** against the captured
   build.
3. Fix your application code and run the replay build command again.
4. Deploy the updated registry and image, and redeploy the backend with its new artifact
   ID.
5. Open the **same original occurrence** and verify the current build against the
   declared success response and business assertions.

A pass confirms that scenario, not every API request. Verification does not automatically
resolve the grouped issue; resolution is an explicit workspace action. New failures can
reopen a resolved issue.

## Validate the deployment

`timemachine doctor` checks configuration, token format, recording policy, registration
and collector connectivity/authentication without ingesting incidents or printing
credentials. Offline mode skips network checks. Warnings indicate incomplete replay
readiness; a passing doctor result does not prove business correctness or that Docker
can execute the scenario.

When an artifact ID is configured, the `record` launcher also asks whether the collector
recognizes it. If readiness cannot be confirmed, basic capture continues with a warning.

Before enabling capture for production traffic, validate a representative failure and
verification scenario in staging. Confirm project access, approved fields, alert
settings, token rotation, and image backup/recovery against your actual infrastructure.

| Problem                                 | What to check                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| Authentication rejected                 | Collector URL, project token, revocation and service-name match                    |
| Capture works but replay is unavailable | Complete approved evidence, registered scenario and matching artifact              |
| Captured image is unregistered          | Deploy the registry containing that exact captured build                           |
| Registered image is missing             | Restore the exact image, or configure its immutable registry backup                |
| Recovery fails                          | Docker connectivity, registry permissions and credential access on the replay host |
| Current verification uses an old build  | Rebuild, deploy the registry/image and remove stale artifact overrides             |

## Development startup

For development, the same installed SDK can run the saved entrypoint with Node watch
mode:

```sh
npx timemachine dev
```

Or explicitly add the dedicated script while preserving your existing scripts:

```sh
npx timemachine script
npm run dev:timemachine
```

Keep one watcher if you already use Nodemon. Neither command compiles TypeScript or
rewrites your frontend/concurrently setup. Development watchers should not be used for
production startup.
