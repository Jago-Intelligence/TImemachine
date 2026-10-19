# Integrate TimeMachine with your backend

Use TimeMachine to capture unexpected backend failures, investigate request and
dependency evidence, and verify supported scenarios after a developer fixes the code.

This guide describes the intended **npm consumer workflow**. It separates application
integration from deploying the shared TimeMachine workspace.

## Availability

**The packages are currently unpublished and private.** The npm commands in these
guides describe how you will integrate after a release; they do not work against the
public registry yet. Repository access and package availability are separate.

For contributing or running from source before release, see the
[development guide](../development.md). The production integration below assumes the
packages are available to your application.

## Choose your integration

| Backend                                        | Recommended guide                                                    | Current scope                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Express 5 · JavaScript                         | [Express setup and code examples](../express-setup.md)               | Automatic unexpected request-failure capture; configured isolated replay |
| Express 5 · TypeScript                         | [Express setup](../express-setup.md) and [TypeScript](typescript.md) | Same SDK; run the compiled application entrypoint                        |
| JavaScript · Node.js HTTP                      | [JavaScript integration](javascript.md)                              | Explicit handler wrapping and capture                                    |
| TypeScript · Node.js HTTP                      | [TypeScript integration](typescript.md)                              | Typed explicit handler wrapping and capture                              |
| Other Node.js frameworks or background workers | [SDK API](../node-sdk.md)                                            | Explicit `captureException`; no claim of automatic framework integration |

JavaScript and TypeScript use the same Node.js SDK. The documented runtime is
**Node.js 24**. SDKs for Python, Go, Java, PHP and .NET are not available yet.

## Packages and infrastructure

| Component                   | Where it runs                   | What it does                                                               |
| --------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `@timemachine/sdk-node`     | Your backend                    | Captures failures, sends evidence and provides the `timemachine` CLI       |
| `@timemachine/replay`       | Build/replay environment        | Defines scenarios, registers trusted images and runs isolated replays      |
| Collector                   | Shared workspace infrastructure | Authenticates ingestion, validates captures and stores incidents           |
| Dashboard                   | Shared workspace infrastructure | Lets developers investigate, replay, verify and manage project access      |
| PostgreSQL incident storage | Workspace infrastructure        | Keeps captures, issue history, workspace settings and alert delivery state |

Install the SDK in your existing application. Install the replay package only where
its runner and build tooling are needed. Package dependencies such as
`@timemachine/core` are intended to resolve through npm after release; application
users do not need to build the monorepo or package archives by hand.

The SDK does **not** deploy a collector, dashboard or database. Your workspace
administrator supplies the shared collector URL, dashboard URL, project and ingestion
token. See [workspace deployment](../self-hosted-setup.md).

## Install and initialize

After publication, from your application's root:

```sh
npm install --save-exact @timemachine/sdk-node
npx timemachine init --service my-api --entry server.js
```

Your Express dependency and application remain your own. For a compiled TypeScript
backend, use `--entry dist/server.js` after building it. Keep the SDK in runtime
dependencies and deploy with a committed lockfile using `npm ci`.

Initialization creates project configuration, private credentials, a recording policy,
startup settings and optional replay templates. It preserves your existing code and
npm scripts and refuses to overwrite an existing `timemachine` directory.

## Connect to your workspace

Set `timemachine/config.json`:

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

Use your actual collector URL and the exact service name belonging to your workspace
project. Team members open the separate dashboard URL in their browser.

Put the project ingestion token from **Dashboard → Workspace → Tokens** in the private,
git-ignored `timemachine/credentials.json`:

```json
{
  "authToken": "YOUR_PROJECT_INGESTION_TOKEN"
}
```

Replace the placeholder with the full token. Keep file permissions private (`chmod 600`
on Unix systems). Alternatively, inject `TIMEMACHINE_AUTH_TOKEN` through your deployment
secret manager and leave the generated credential value empty. Do not bake credentials
into images or place them in public configuration.

Process environment overrides project JSON and private credentials. Your application's
existing `.env` does not need TimeMachine changes. See
[project configuration](../project-configuration.md) for all supported overrides.

## Start automatic Express capture

Add or merge this startup script:

```json
{
  "scripts": {
    "start": "timemachine record"
  }
}
```

Then validate setup and start the backend from its project root:

```sh
npx timemachine doctor
npm start
```

The recording launcher installs instrumentation before your application loads. Keep
normal Express routes and error handling; you do not need `tm.error()` in every route.
Successful responses and ordinary 4xx errors are ignored by default. Unexpected failures
are captured across observed routes.

For an existing Node command, use the preload instead:

```sh
node --import=@timemachine/sdk-node/automatic dist/server.js
```

Choose one integration per process to avoid duplicate captures. The direct preload does
not perform the launcher's online replay-readiness check. Neither method builds your
application or starts workspace infrastructure.

[See a complete Express app-factory and startup example](../express-setup.md#use-it-in-application-code).

## Explicit capture for other work

For a caught background-job error, initialize the explicit client with the same project
configuration:

```js
import { createTimeMachineFromConfig } from '@timemachine/sdk-node';

const tm = createTimeMachineFromConfig();

try {
  await runYourBackgroundJob(); // Replace with your actual job function.
} catch (error) {
  tm.captureException(error, { code: 'BACKGROUND_JOB_FAILED' });
  // Apply your worker's normal retry or failure handling here.
}

// For this one-off worker: wait briefly for queued captures before exiting.
await tm.close({ timeoutMs: 2000 });
```

For a long-running worker, create the client once and close it during graceful shutdown,
not after each job. A queued capture is not a delivery guarantee. Avoid explicitly
capturing a request error already observed by the automatic Express integration.

See the [SDK API](../node-sdk.md) for request context, native HTTP wrapping, queue limits,
`flush`, `close` and delivery statistics.

## Enable evidence recording and replay

Basic capture does not require a complete replay scenario. To reproduce saved behavior:

1. Approve safe request fields and supported dependency results in
   `timemachine/recording-policy.json`.
2. Install `@timemachine/replay` after publication and configure an app factory, controlled
   dependencies, expected response and meaningful business assertions.
3. Review approved build files and run `npx timemachine replay build` with Docker
   available. It registers the image and updates the recorder artifact ID.
4. Deploy the image and registry JSON to the shared collector's replay host. A local
   build does not upload workspace configuration.
5. Capture a failure, replay its original build, fix the application code, rebuild and
   verify the same occurrence against the updated build.

Replay requires supported complete inputs or reviewed synthetic fixtures. It does not
reconstruct arbitrary production state, change your code or automatically resolve an
issue. A passing verification proves the configured scenario only.

Optional private-registry backups preserve immutable image references and let the
replay host recover missing images after verifying their identity. Keep builds while
retained captures need them. See [replay setup](../express-setup.md#add-isolated-replay)
and [retention and recovery](../replay.md).

## Supported dependency scope

| Dependency                                             | Documentation                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Native `fetch` and Axios                               | [HTTP recording](../http-dependency-recording.md) and [adapters](../dependency-adapters.md) |
| PostgreSQL `pg` reads                                  | [PostgreSQL recording](../postgres-recording.md)                                            |
| PostgreSQL writes/transactions with reviewed test data | [Synthetic database replay](../synthetic-postgres-replay.md)                                |
| Selected mysql2, MongoDB and BullMQ operations         | [Supported operation adapters and limitations](../dependency-adapters.md)                   |

Support is operation-specific. Do not assume arbitrary ORM calls, streaming traffic or
all queue/database behavior can be recorded and replayed.

## Team access, alerts and production validation

Manage individual accounts, project assignments and project-bound ingestion tokens in
**Workspace**. Configure Slack, email, Teams, Discord and custom webhooks in **Alerts**.
Provider credentials belong to workspace infrastructure, not each application's SDK.

Before production rollout, verify a representative failure in staging, review approved
fields and token access, test collector outages and shutdown handling, and exercise
replay/backup against your actual infrastructure. SDK queues are bounded and in-memory;
crashes, overload or prolonged collector outages can lose captures.

- [Express production setup](../express-setup.md)
- [Workspace accounts and project access](../workspace-access.md)
- [Alerts](../alerts.md)
- [Collector](../collector.md)
- [Storage](../storage.md)
- [Security policy](../../SECURITY.md)
