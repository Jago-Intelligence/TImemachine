# Replay your own Express app

The custom Express adapter runs your application factory in a disposable Docker
container. You define the test request, controlled dependencies and business
assertions. The dashboard compares the saved failure with the current application
build and verifies those assertions, not just an HTTP status.

The packages are currently unpublished; npm examples describe the intended release
workflow. Replay requires Node.js 24, Docker, the collector and compatible SDK/replay packages. It
supports GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS requests against a registered
route. It does not automatically reconstruct arbitrary production state.

## Application structure

Separate app creation from startup. Export a factory that accepts dependencies:

```js
export function createApp({ repository }) {
  const app = express();
  // Register your normal application routes and error handling.
  // Use repository instead of creating a production connection here.
  return app;
}
```

Your normal server injects its real dependencies and starts listening. The replay
entry point imports the same factory, injects fresh in-memory test doubles or
in-process test dependencies, and lets the runner start its isolated listener.
Do not start servers or connect to production services as import side effects.

## Define a reviewed scenario

In your own `replay-entry.js`:

```js
import { defineExpressReplay, runExpressReplay } from '@timemachine/replay';
import { createApp } from './app.js';

const adapter = defineExpressReplay([
  {
    contract: {
      service: 'my-api',
      profile: 'rename-profile-v1',
      scenarioVersion: 'v1',
      method: 'PATCH',
      route: '/profiles/:id',
      failureCode: 'PROFILE_UPDATE_FAILED',
      target: { statusCode: 200, errorCode: null, outcome: 'scenario-assertions-passed' },
    },
    async create() {
      const users = new Map([['test-user', { id: 'test-user', displayName: 'Before' }]]);
      const repository = {
        get: (id) => users.get(id),
        update: (id, displayName) => {
          const user = { id, displayName };
          users.set(id, user);
          return user;
        },
      };
      return {
        handler: createApp({ repository }),
        request: {
          path: '/profiles/test-user',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayName: '  Ada  ' }),
        },
        assert({ response, body }) {
          return (
            response.status === 200 &&
            body?.user?.id === 'test-user' &&
            body.user.displayName === 'Ada' &&
            users.get('test-user').displayName === 'Ada'
          );
        },
        // Optional async close(): dispose resources you created for this test.
      };
    },
  },
]);

await runExpressReplay(adapter);
```

Use your own routes and repository interface. Every run creates new test state.
An assertion must return the boolean `true`; false, a thrown assertion error or a
truthy non-boolean value does not pass. Use `body`, which the runner has already
read and parsed, instead of reading `response.json()` again. Use `text` for a bounded
plain-text response assertion. For multi-step checks,
use `await request('/auth/me', { headers: { authorization: testSession } })` inside
`assert`. Requests stay inside the test app; redirects are not followed and external request
URLs are rejected.
Use only synthetic users, passwords and tokens.

The route template supports literal path segments and `:parameter` segments. Fill
parameters with test values in `request.path`. The request must match that template.
The target is stored with the fixture and cannot be changed in the dashboard to
make a failing check pass. A 200 response without passing business assertions fails
verification.

## Package installation and image

After publication, install the replay package where your runner/build tooling runs:

```sh
npm install --save-exact @timemachine/replay
```

The [Express build guide](express-setup.md#build-a-trusted-replay-image) documents
`npx timemachine replay build` for standalone projects. Custom images remain useful for
monorepos or system dependencies outside the standard builder.

Build a Node.js image containing your application code, test scenario and installed
packages. Its entrypoint must be:

```dockerfile
USER node
ENTRYPOINT ["node", "replay-entry.js"]
```

For TypeScript use the compiled entrypoint, such as `dist/replay-entry.js`. The
runtime user must work as UID/GID 1000. Do not copy `.env`, production credentials,
private keys or customer data into the image. Keep runtime prerequisites in the
image; the runner has no external network, host mounts or forwarded app secrets.
A full workspace Dockerfile is provided at
[`infra/delivery-replay.Dockerfile`](../infra/delivery-replay.Dockerfile).

## Register a built image

For a custom image, run in your application/build environment:

```sh
npx timemachine-replay register --service my-api --image my-api-replay:local
```

Registration inspects a local image and runs its `--describe` entrypoint under the
same Docker restrictions to obtain reviewed metadata. It does not pull images or
run the application's scenario setup. App imports must be free of startup effects.
The service must match the SDK's service name. Metadata files contain image IDs,
contracts and hashes, not test inputs or credentials.

Set the collector's ignored `.env` to the printed absolute registry path:

```dotenv
REPLAY_APPS_FILE=/absolute/path/replay-apps.json
```

Configure the registry path on the collector and deploy the metadata and matching image
there. Valid changes to its configured file reload automatically; changing the path
requires a restart. Registrations preserve historical image IDs and fail at capacity
rather than silently evicting builds. Keep required images or immutable backups for
retained captures. The sandbox is for trusted reviewed application code.

## Mark only a matching input case

In your live backend, read the generated fixture for the matching application build:

```js
import { readFileSync } from 'node:fs';
import { replayFixtureSchema } from '@timemachine/core';

const metadata = JSON.parse(readFileSync('.timemachine/my-api-fixtures.json', 'utf8'));
const fixture = replayFixtureSchema.parse(
  metadata.find((row) => row.profile === 'rename-profile-v1'),
);
```

Use the SDK's normal request middleware before parsers/routes. Within the relevant
route, after validation, explicitly select the reviewed case:

```js
app.patch(
  '/profiles/:id',
  (req, res, next) => {
    if (matchesReviewedInputCase(req)) {
      return requests.replay(fixture)(req, res, next);
    }
    next();
  },
  updateProfileHandler,
);
```

`matchesReviewedInputCase` and `updateProfileHandler` are your application functions.
The predicate must select the condition your synthetic scenario represents. It
can inspect inputs in your backend, but the SDK does not save those inputs. Do not
label unrelated requests with one scenario merely because they share a route.

Keep `requests.errorHandler` before the final error responder. Completed 5xx failures
on selected requests receive the fixture reference automatically, using its reviewed
failure code. Successful requests and normal 4xx rejections are excluded by default.
Other unselected failures are still captured without a replay fixture.

Deploy fixture metadata with the exact app build it represents. After modifying
application code, build/register the new image and deploy its registry and image to the replay host. Retain
old images for captured-build replay. Do not rewrite old incident fixtures.

## Verify and automate

Open the saved occurrence and click **Verify application fix**. The runner uses the
owning app's current image with the original scenario, then checks the registered
status, error code, optional retry delay and positive business-assertion outcome.
Each run keeps its image ID and target in history. Incidents and grouped issues are
not automatically deleted or resolved after one scenario passes.

For a regression check without the collector/dashboard:

```sh
npx timemachine-replay check --service my-api --profile rename-profile-v1 --registry /absolute/path/replay-apps.json
```

This standalone check applies to registered fixture scenarios; recorded-input contracts
need saved occurrence inputs and use the dashboard. A failed check exits nonzero. Build/register the current image before running
it in automation. This checks one registered case, not all application behavior.

Contracts are hashed from declared metadata and the scenario factory's code. Fixing
an imported application module preserves the same scenario. Changing its inputs,
assertions, route or target changes the contract and blocks comparison against an
old occurrence. Keep test inputs and assertions self-contained in the factory; changing captured
external variables is not detected. Changes to imported test-fixture helpers also
require a scenario version bump; their source is not automatically included in the factory hash.
Use the same built entrypoint to generate metadata and execute replay; different
transpiler output can change the factory hash.

Only structured metadata, timings and the safe assertion outcome leave the sandbox.
Initial response bodies are bounded to 32 KiB and are not saved. Application logs
are discarded by the collector's executor. General production-data reconstruction,
external-network test dependencies and automatic discovery of arbitrary replay
scenarios remain outside this adapter.
