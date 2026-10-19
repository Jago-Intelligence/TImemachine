import { startupEnvironment } from './startup.js';
import { readFileSync, statSync } from 'node:fs';
import { recordingPolicySchema } from './recording-policy.js';
import { createTimeMachine } from './client.js';
import { installAutomaticRecording } from './automatic.js';

try {
  Object.assign(process.env, startupEnvironment(process.cwd(), process.env));
  const policyFile = process.env.TIMEMACHINE_RECORDING_POLICY;
  if (policyFile && statSync(policyFile).size > 65536)
    throw new Error('Recording policy too large');
  const policy = policyFile
    ? recordingPolicySchema.parse(JSON.parse(readFileSync(policyFile, 'utf8')))
    : undefined;
  if (policy && process.env.TIMEMACHINE_REPLAY_ARTIFACT_ID)
    policy.artifactId = recordingPolicySchema.shape.artifactId.parse(
      process.env.TIMEMACHINE_REPLAY_ARTIFACT_ID,
    );
  const sdk = createTimeMachine({
    collectorUrl: process.env.TIMEMACHINE_COLLECTOR_URL ?? 'http://127.0.0.1:4318',
    token: process.env.TIMEMACHINE_AUTH_TOKEN ?? '',
    service: {
      name: process.env.TIMEMACHINE_SERVICE_NAME ?? 'node-app',
      version: process.env.TIMEMACHINE_SERVICE_VERSION ?? '0.1.0',
      environment: process.env.TIMEMACHINE_ENVIRONMENT ?? 'development',
    },
    sourceRoot: process.cwd(),
    ...(policy?.sourceEvidenceFiles
      ? { sourceEvidenceFiles: policy.sourceEvidenceFiles }
      : {}),
  });
  const instrumentation = installAutomaticRecording(sdk, policy);
  process.stderr.write(
    instrumentation.expressErrors
      ? 'TimeMachine: Express 5 error source locations enabled.\n'
      : 'TimeMachine: HTTP capture enabled; automatic Express error source locations unavailable for this entrypoint.\n',
  );
  if (instrumentation.postgres)
    process.stderr.write('TimeMachine: pg 8 query observation enabled.\n');
  // Observe fatal exceptions without swallowing them or changing exit behavior.
  process.on('uncaughtExceptionMonitor', (error) => {
    sdk.captureException(error, { code: 'UNCAUGHT_EXCEPTION' });
  });
  let draining = false;
  process.on('beforeExit', () => {
    if (draining) return;
    draining = true;
    void sdk.close({ timeoutMs: 2000 });
  });
} catch {
  process.stderr.write(
    'TimeMachine recording configuration is invalid. Check collector credentials and service settings.\n',
  );
  process.exitCode = 1;
  throw new Error('TimeMachine automatic recording could not initialize');
}
