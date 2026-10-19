import { createTimeMachine } from './client.js';
import { startupEnvironment } from './startup.js';
/** Create the explicit SDK using the same project configuration as the recorder CLI. */
export function createTimeMachineFromConfig(root = process.cwd()) {
  const env = startupEnvironment(root, process.env);
  return createTimeMachine({
    collectorUrl: env.TIMEMACHINE_COLLECTOR_URL ?? 'http://127.0.0.1:4318',
    token: env.TIMEMACHINE_AUTH_TOKEN ?? '',
    service: {
      name: env.TIMEMACHINE_SERVICE_NAME ?? 'node-app',
      version: env.TIMEMACHINE_SERVICE_VERSION ?? '0.1.0',
      environment: env.TIMEMACHINE_ENVIRONMENT ?? 'development',
    },
    sourceRoot: root,
  });
}
