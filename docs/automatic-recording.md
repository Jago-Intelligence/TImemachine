# Automatic Node.js recording

The Node SDK starts your application with a recording preload. Express routes keep
their normal handlers; unexpected failures are observed without per-route capture calls.

## Install and start

The packages are currently unpublished. After the npm release:

```sh
npm install --save-exact @timemachine/sdk-node
npx timemachine init --service my-api --entry server.js
npx timemachine doctor
npx timemachine record
```

Run from your application's root. Configure the shared collector URL in
`timemachine/config.json` and its project token in private credentials or a deployment
secret manager. See [Express setup](express-setup.md) for production startup and code.

`record` starts the saved Node entrypoint once; `dev` adds Node watch mode. Neither
builds TypeScript nor deploys infrastructure. The explicit form accepts Node flags:

```sh
npx timemachine record -- node dist/server.js
```

For an existing production Node command, preload directly instead:

```sh
node --import=@timemachine/sdk-node/automatic dist/server.js
```

Use one integration per process. Do not wrap the automatic recorder in a second
manual Express instrumentation layer. Arbitrary non-Node executables or process trees
are not launch targets.

## What is observed

The preload establishes an asynchronous request scope before the application's HTTP
listeners run. It links supported dependency events to the incoming request. Completed
5xx responses and supported interrupted requests create incidents; successful requests
and expected 4xx responses do not by default.

Express 5 error forwarding uses a version-guarded router hook for available project
source locations. Existing error responders remain in control. Errors swallowed by
application code, status-only failures and unsupported framework versions may not
provide an exception stack.

Routes come from safe templates, not raw customer URLs. Missing templates use
`/:unmatched`; mounted router prefixes may require explicit reviewed route templates.
A request ID is added where response headers permit it. Timeline events include bounded
start offsets, durations and outcomes, not unrestricted HTTP payloads.

## Approved dependency evidence

Native global fetch and supported pg promise-query observation are installed by the
preload. Axios instances, mysql2 promise clients, MongoDB collections and BullMQ queues
need the documented explicit wrappers. Their supported scope is limited:
[dependency adapters](dependency-adapters.md).

A reviewed `timemachine/recording-policy.json` selects safe request/result fields.
Empty rules allow basic failure investigation but cannot provide complete replay inputs.
See [failed request recording](failed-request-recording.md). Unmatched, incomplete,
oversized or pending evidence can prevent automatic replay generation.

## Runtime and delivery limits

- This is runtime instrumentation, not eBPF or a transparent network proxy.
- HTTP/2, arbitrary HTTP clients, worker threads and child processes are not implicitly
  covered by starting their parent through the CLI.
- Shared runtime interfaces are patched. Validate your application's actual versions
  and middleware configuration in staging.
- Fatal exceptions retain Node's normal crash behavior. No global unhandled-rejection
  handler is installed to change application behavior.
- SDK delivery is bounded and in-memory. Crashes, overload and prolonged collector
  outages can lose captures; graceful application shutdown should drain the queue.
- Source snapshots and permitted fields have limits; raw source text and raw exception
  messages are not uploaded as general capture payloads.

When a recorder artifact is configured, the CLI checks whether the collector recognizes
it before starting. An unavailable check warns but still permits basic capture. The
direct preload does not run this CLI readiness check. `doctor` validates configuration
and connectivity, not business correctness or Docker execution.

## Validate your integration

Exercise an unexpected failure, a normal successful route and a 401/400 route in staging.
Only the unexpected failure should appear as an incident by default. Confirm route,
timing, approved fields and source locations without exposing secrets. A trusted replay
scenario is still required to reproduce and verify:
[automatic replay](automatic-replay.md) and [custom replay](custom-express-replay.md).
