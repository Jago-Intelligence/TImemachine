# Backend project configuration

The SDK packages are currently private/unpublished. After publication, install the SDK as documented in [integration](integrations/README.md), then initialize from your Express project's root:

```sh
npx timemachine init --service my-api --entry server.js
```

Initialization preserves existing application files and refuses to overwrite an existing `timemachine/` directory. It creates connection settings, a private credential file, recording policy, saved startup settings and a replay runner template. It does not start the self-hosted collector or generate a new collector token.

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

This file contains no credentials and can be committed. Add `replayArtifactId` with your registered `sha256:...` image ID when configuring replay. Edit `timemachine/start.json` for the Node entrypoint and argument array.

Edit the generated **private** `timemachine/credentials.json`:

```json
{ "authToken": "YOUR_PROJECT_INGESTION_TOKEN" }
```

In account mode, generate a service-bound ingestion token in Dashboard → Workspace. The service name must match its project. Legacy mode still uses the existing shared collector token. The initializer sets permissions to 600 and adds the file to `timemachine/.gitignore`. Do not commit it or embed tokens in `config.json`. If you move credentials to a custom path, ignore that path too. On Unix, overly open credential permissions are rejected; restore them with `chmod 600 timemachine/credentials.json`. Project paths and symlinks must stay inside the project. Configuration files have bounded size and errors never print credential values.

Start and diagnose:

```sh
timemachine doctor --offline
timemachine record
timemachine dev
```

The automatic preload also reads these files when using `timemachine record -- node server.js` or `node --import @timemachine/sdk-node/automatic server.js`. Run from the project root. Restart your backend after editing its connection settings.

For explicit SDK use:

```js
import { createTimeMachineFromConfig } from '@timemachine/sdk-node';
const tm = createTimeMachineFromConfig();
```

This initializes the SDK; use its Express instrumentation/wrappers for request capture. The automatic recorder CLI installs request instrumentation for you.

Precedence is process environment overrides, then JSON configuration/private credentials, then the legacy saved `.env` file. Existing `.env` installations remain compatible. A blank token in the generated credential file allows an existing environment token to remain in use. CI/production can inject `TIMEMACHINE_AUTH_TOKEN` using their secret manager without creating a credential file; project configuration still supplies the URL and identity. Do not override values accidentally with stale environment settings.

Configure Slack, email, Teams and Discord in **Dashboard → Alerts**. Those credentials stay encrypted on the collector. The self-hosting administrator still configures collector/database/dashboard infrastructure secrets; application developers do not need those database passwords or notification keys. This change simplifies backend integration without turning TimeMachine into a hosted service. See [Workspace access](workspace-access.md) for project tokens and individual accounts.
