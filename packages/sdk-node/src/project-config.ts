import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseOptions } from './options.js';

export const projectConfigSchema = z.strictObject({
  version: z.literal(1),
  collectorUrl: z.url(),
  service: z.strictObject({
    name: z.string(),
    version: z.string(),
    environment: z.string(),
  }),
  credentialsFile: z.string().min(1).max(1024).default('timemachine/credentials.json'),
  recordingPolicy: z
    .string()
    .min(1)
    .max(1024)
    .default('timemachine/recording-policy.json'),
  replayArtifactId: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  replayRegistry: z.string().min(1).max(1024).default('.timemachine/replay-apps.json'),
});
function localPath(root: string, value: string) {
  const path = resolve(root, value);
  const rel = relative(resolve(root), path);
  if (isAbsolute(value) || isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
    throw new Error('TimeMachine file paths must be inside the project.');
  if (existsSync(path)) {
    const actual = relative(realpathSync(root), realpathSync(path));
    if (isAbsolute(actual) || actual === '..' || actual.startsWith('../'))
      throw new Error('TimeMachine file paths must be inside the project.');
  }
  return path;
}
function json(path: string) {
  if (statSync(path).size > 65536)
    throw new Error('TimeMachine configuration is too large.');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('Invalid TimeMachine JSON configuration.');
  }
}
export function projectEnvironment(root: string): NodeJS.ProcessEnv {
  const path = localPath(root, 'timemachine/config.json');
  if (!existsSync(path)) return {};
  const parsed = projectConfigSchema.safeParse(json(path));
  if (!parsed.success)
    throw new Error(
      'Invalid timemachine/config.json. Put tokens only in the private credentials file.',
    );
  const config = parsed.data;
  try {
    parseOptions({
      collectorUrl: config.collectorUrl,
      token: 'x'.repeat(32),
      service: config.service,
    });
  } catch {
    throw new Error('Invalid collector URL or service in timemachine/config.json.');
  }
  const credentialPath = localPath(root, config.credentialsFile);
  let token: string | undefined;
  if (existsSync(credentialPath)) {
    if (process.platform !== 'win32' && (statSync(credentialPath).mode & 0o077) !== 0)
      throw new Error(
        'Credential file permissions are too open. Run chmod 600 on your TimeMachine credentials file.',
      );
    const credentials = z
      .strictObject({ authToken: z.string().max(256) })
      .safeParse(json(credentialPath));
    if (!credentials.success)
      throw new Error('Invalid private TimeMachine credentials file.');
    if (credentials.data.authToken) {
      try {
        parseOptions({
          collectorUrl: config.collectorUrl,
          token: credentials.data.authToken,
          service: config.service,
        });
      } catch {
        throw new Error('Invalid private TimeMachine token.');
      }
      token = credentials.data.authToken;
    }
  }
  return {
    TIMEMACHINE_COLLECTOR_URL: config.collectorUrl,
    TIMEMACHINE_SERVICE_NAME: config.service.name,
    TIMEMACHINE_SERVICE_VERSION: config.service.version,
    TIMEMACHINE_ENVIRONMENT: config.service.environment,
    TIMEMACHINE_RECORDING_POLICY: localPath(root, config.recordingPolicy),
    REPLAY_APPS_FILE: localPath(root, config.replayRegistry),
    ...(token ? { TIMEMACHINE_AUTH_TOKEN: token } : {}),
    ...(config.replayArtifactId
      ? { TIMEMACHINE_REPLAY_ARTIFACT_ID: config.replayArtifactId }
      : {}),
  };
}
