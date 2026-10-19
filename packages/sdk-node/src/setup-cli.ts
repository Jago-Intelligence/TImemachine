import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { recordingPolicySchema } from './recording-policy.js';
import { parseOptions } from './options.js';
import { replayAppRegistrySchema } from '@timemachine/core';
import { startupSchema, projectPath } from './startup.js';

function readJson(path: string): unknown {
  if (statSync(path).size > 65536) throw new Error('Configuration too large');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function initializeProject(root: string, service: string, entrypoint = 'app.js') {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(service))
    throw new Error(
      'Use a service name with letters, numbers, dots, underscores or hyphens (maximum 64 characters).',
    );
  parseOptions({
    collectorUrl: 'http://127.0.0.1:4318',
    token: 'x'.repeat(32),
    service: { name: service, version: '0.1.0', environment: 'development' },
  });
  const startup = startupSchema.parse({
    version: 1,
    entrypoint,
    nodeArgs: [],
    envFile: 'timemachine/.env',
  });
  projectPath(root, startup.entrypoint);
  const directory = join(root, 'timemachine');
  if (existsSync(directory))
    throw new Error('The timemachine directory already exists; no files were changed.');
  mkdirSync(directory);
  const files: Record<string, string> = {
    'start.json': JSON.stringify(startup, null, 2) + '\n',
    'recording-policy.json':
      JSON.stringify(
        {
          id: `${service}-v1`,
          requests: [],
          dependencies: [],
          postgres: [],
          sourceEvidenceFiles: [],
        },
        null,
        2,
      ) + '\n',
    '.gitignore': '.env\ncredentials.json\n',
    'config.json':
      JSON.stringify(
        {
          version: 1,
          collectorUrl: 'http://127.0.0.1:4318',
          service: { name: service, version: '0.1.0', environment: 'development' },
          credentialsFile: 'timemachine/credentials.json',
          recordingPolicy: 'timemachine/recording-policy.json',
          replayRegistry: '.timemachine/replay-apps.json',
        },
        null,
        2,
      ) + '\n',
    'credentials.json': JSON.stringify({ authToken: '' }, null, 2) + '\n',
    '.env.example': `TIMEMACHINE_COLLECTOR_URL=http://127.0.0.1:4318\nTIMEMACHINE_AUTH_TOKEN=\nTIMEMACHINE_SERVICE_NAME=${service}\nTIMEMACHINE_SERVICE_VERSION=0.1.0\nTIMEMACHINE_ENVIRONMENT=development\nTIMEMACHINE_RECORDING_POLICY=timemachine/recording-policy.json\nTIMEMACHINE_REPLAY_ARTIFACT_ID=\nREPLAY_APPS_FILE=.timemachine/replay-apps.json\n`,
    'replay.json':
      JSON.stringify(
        {
          version: 1,
          runner: 'timemachine/replay-runner.mjs',
          files: [
            'package.json',
            ...(existsSync(join(root, 'pnpm-lock.yaml'))
              ? ['pnpm-lock.yaml']
              : ['package-lock.json']),
            ...(existsSync(join(root, 'src')) ? ['src'] : [entrypoint]),
            'timemachine/replay-runner.mjs',
          ],
        },
        null,
        2,
      ) + '\n',
    'replay-runner.mjs': `import { defineExpressReplay, runExpressReplay } from '@timemachine/replay';
// Import your app factory here. It must create an app without listening or connecting
// to production dependencies. Inject dependencies.postgres for recorded pg reads.
await runExpressReplay(defineExpressReplay([{
  contract: {
    inputMode: 'recorded-http', service: '${service}', profile: 'replace-me-v1',
    scenarioVersion: 'v1', method: 'POST', route: '/replace-me', failureCode: 'HTTP_500',
    target: { statusCode: 200, errorCode: null, outcome: 'scenario-assertions-passed' },
  },
  async create(recording, dependencies) {
    // Return { handler: createApp({ database: dependencies.postgres }),
    //   request: { path: '/replace-me' },
    //   assert: ({ response, body }) => /* your business checks */ false };
    throw new Error('Configure your app factory and business assertions before registration');
  },
}]));
`,
    'README.md': `# TimeMachine setup for ${service}

1. Set collectorUrl and service in config.json. Paste your project ingestion token from Dashboard → Workspace
   into authToken in credentials.json (private, ignored by Git, permissions 600).
   Never put credentials in config.json. No application .env edits are required.
   This setup does not start a collector or install packages.
   Configure Slack/email/Teams/Discord in the dashboard Notifications page.
2. Edit recording-policy.json: approve routes and safe body fields, HTTP dependency
   response fields and pg queries. Empty rules still permit basic failure capture,
   but cannot provide complete replay inputs. Do not approve passwords or tokens.
3. Start from the project root:

   timemachine record

   For automatic restart: timemachine dev (uses Node watch mode).
   Change entrypoint/nodeArgs in start.json. Existing process environment wins
   over config.json/credentials.json; legacy .env files remain a fallback. The explicit record -- node ... command remains available.

4. Configure replay-runner.mjs with your app factory, route and meaningful business
   assertions. It intentionally fails until configured. Install the replay package
   from the TimeMachine workspace/local package; packages are currently private.
5. Review replay.json: files is the explicit list of source files and dependency manifests
   sent to Docker. Include imported modules and assets. Never include credentials or .env.
   Add buildScript: "build" for a package build step, if needed. npm and pinned pnpm
   projects are supported; local/workspace package dependencies require a custom image.
   Optional: add backupRepository: "registry.company.com/team/api-replay" to replay.json
   and authenticate Docker using docker login on build and replay hosts. Registry credentials
   stay in Docker; backup metadata contains only immutable digests.
   Then run from the project root:

   timemachine replay build

   This builds the image, validates its manifest, registers it, and updates
   replayArtifactId in config.json automatically. Install @timemachine/replay alongside
   the SDK to use this command. Existing captured image IDs remain in the registry.
6. Set REPLAY_APPS_FILE to the registry path on the collector and restart it. For a
   remote collector, deploy the registry AND image on its replay host; this command
   does not upload artifacts. Restart your recorded app after a successful build.
7. Check setup:

   timemachine doctor

8. Capture a new failure, open its dashboard occurrence, replay the captured build,
   fix your code, run timemachine replay build again, restart your recorded app with its new
   artifact ID, and verify the original occurrence against the current build.

Use doctor --offline for configuration checks without network access. Passing doctor
checks configuration and connectivity, not business correctness or sandbox execution.
`,
  };
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(directory, name), content, {
      flag: 'wx',
      mode: name.startsWith('.env') || name === 'credentials.json' ? 0o600 : 0o644,
    });
}

export async function diagnoseProject(
  root: string,
  env: NodeJS.ProcessEnv,
  offline: boolean,
  fetcher: typeof fetch = fetch,
) {
  const results: { status: 'pass' | 'warn' | 'fail'; message: string }[] = [];
  let config: ReturnType<typeof parseOptions> | undefined;
  try {
    config = parseOptions({
      collectorUrl: env.TIMEMACHINE_COLLECTOR_URL ?? 'http://127.0.0.1:4318',
      token: env.TIMEMACHINE_AUTH_TOKEN ?? '',
      service: {
        name: env.TIMEMACHINE_SERVICE_NAME ?? 'node-app',
        version: env.TIMEMACHINE_SERVICE_VERSION ?? '0.1.0',
        environment: env.TIMEMACHINE_ENVIRONMENT ?? 'development',
      },
    });
    results.push({
      status: 'pass',
      message: 'Collector URL, credentials format and service metadata are valid.',
    });
  } catch {
    results.push({
      status: 'fail',
      message:
        'Invalid collector URL, token or service metadata. Check TIMEMACHINE settings; credentials are never printed.',
    });
  }
  let policy: ReturnType<typeof recordingPolicySchema.parse> | undefined;
  try {
    policy = recordingPolicySchema.parse(
      readJson(
        resolve(
          root,
          env.TIMEMACHINE_RECORDING_POLICY ?? 'timemachine/recording-policy.json',
        ),
      ),
    );
    results.push({
      status: 'pass',
      message: 'Recording policy and approved PostgreSQL query patterns are valid.',
    });
    if (!policy.requests.length)
      results.push({
        status: 'warn',
        message:
          'No routes approved: basic failures can be captured, but recorded-request replay is not configured.',
      });
    const ids = [
      ...policy.dependencies.map((rule) => rule.id),
      ...(policy.postgres ?? []).map((rule) => rule.id),
      ...(policy.operations ?? []).map((rule) => rule.id),
    ];
    if (new Set(ids).size !== ids.length)
      results.push({ status: 'fail', message: 'Dependency rule IDs must be unique.' });
  } catch {
    results.push({
      status: 'fail',
      message:
        'Recording policy is missing, too large or invalid. Check routes, safe fields and supported queries.',
    });
  }
  try {
    const registry = replayAppRegistrySchema.parse(
      readJson(resolve(root, env.REPLAY_APPS_FILE ?? '.timemachine/replay-apps.json')),
    );
    const app = registry.apps.find((app) => app.service === config?.service.name);
    const artifact = env.TIMEMACHINE_REPLAY_ARTIFACT_ID || policy?.artifactId;
    if (!app || !artifact || app.currentArtifactId !== artifact)
      throw new Error('Mismatch');
    results.push({
      status: 'pass',
      message: 'Service replay registration matches the recorder artifact.',
    });
    for (const route of policy?.requests ?? [])
      if (
        !app.fixtures.some(
          (fixture) =>
            fixture.method === route.method &&
            fixture.route === route.route &&
            fixture.inputMode === (route.databaseMode ?? 'recorded-http'),
        )
      )
        results.push({
          status: 'warn',
          message: `Approved route ${route.method} ${route.route} has no recorded-request replay contract.`,
        });
  } catch {
    results.push({
      status: 'warn',
      message:
        'Replay registration is unavailable or does not match the recorder artifact. Register your image and copy its artifact ID before capturing replay scenarios.',
    });
  }
  if (config && !offline) {
    for (const [path, message, authenticated] of [
      ['/health/ready', 'Collector readiness', false],
      [
        env.TIMEMACHINE_AUTH_TOKEN?.startsWith('tm_')
          ? '/v1/workspace/token'
          : '/v1/incidents?limit=1',
        'Authenticated collector access',
        true,
      ],
    ] as const) {
      try {
        const response = await fetcher(`${config.collectorUrl}${path}`, {
          headers: authenticated ? { authorization: `Bearer ${config.token}` } : {},
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        });
        await response.body?.cancel();
        results.push({
          status: response.ok ? 'pass' : 'fail',
          message: `${message}: ${response.ok ? 'available' : 'rejected or unavailable'}.`,
        });
      } catch {
        results.push({
          status: 'fail',
          message: `${message}: connection failed or timed out.`,
        });
      }
    }
  } else if (offline)
    results.push({
      status: 'warn',
      message: 'Offline mode: collector connectivity and authentication were not tested.',
    });
  return results;
}
