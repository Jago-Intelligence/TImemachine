import { statSync } from 'node:fs';
import { createWorkspace } from './workspace.js';
import { createNotificationSettings } from './notification-settings.js';
import {
  createDockerExecutor,
  readReplayApps,
  type ReplayExecutor,
} from '@timemachine/replay';
import { createReplayService } from './replay-service.js';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { ServerConfig } from '@timemachine/config';
import { INCIDENT_LIMITS } from '@timemachine/core';
import { createLogger } from '@timemachine/logger';
import { ApiError, installErrorHandling, sendApiError } from './errors.js';
import { installRequestContext, requestId } from './request-context.js';
import { installRoutes } from './routes.js';
import { createShutdown } from './shutdown.js';
import type { IncidentStore } from '@timemachine/storage';

interface CollectorOptions {
  config: ServerConfig;
  store: IncidentStore;
  logger?: FastifyBaseLogger;
  replayExecutor?: ReplayExecutor;
}

export async function createCollector(
  options: CollectorOptions,
): Promise<{ app: FastifyInstance; shutdown: () => Promise<void> }> {
  const { config, store } = options;
  const token = config.TIMEMACHINE_AUTH_TOKEN;
  if (!token) throw new Error('TIMEMACHINE_AUTH_TOKEN is required for collector startup');
  const logger: FastifyBaseLogger =
    options.logger ?? createLogger({ service: 'collector', level: config.LOG_LEVEL });
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    genReqId: requestId,
    requestIdHeader: false,
    frameworkErrors: sendApiError,
    trustProxy: false,
    bodyLimit: INCIDENT_LIMITS.bytes,
    requestTimeout: 15000,
    connectionTimeout: 20000,
    keepAliveTimeout: 5000,
    forceCloseConnections: 'idle',
    return503OnClosing: false,
  });
  let draining = false;
  installRequestContext(app);
  app.addHook('onRequest', async (request) => {
    if (
      draining &&
      request.routeOptions.url !== '/health/live' &&
      request.routeOptions.url !== '/health/ready'
    ) {
      throw new ApiError(503, 'SHUTTING_DOWN');
    }
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      if (!Buffer.isBuffer(body)) return done(new ApiError(400, 'INVALID_JSON'));
      try {
        done(null, new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        done(new ApiError(400, 'INVALID_JSON'));
      }
    },
  );
  await app.register(rateLimit, {
    global: false,
    allowList: (request) =>
      request.routeOptions.url === '/health/live' ||
      request.routeOptions.url === '/health/ready',
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
  });
  // Install before route authentication so rejected credentials still consume the budget.
  app.addHook('onRequest', app.rateLimit());
  installErrorHandling(app);
  const replayApps = readReplayApps(config.REPLAY_APPS_FILE);
  const artifacts = [
    ...new Set([
      ...(config.REPLAY_IMAGE_ID ? [config.REPLAY_IMAGE_ID] : []),
      ...replayApps.apps.flatMap((app) => app.artifacts),
      ...(config.REPLAY_IMAGE_IDS?.split(',') ?? []),
    ]),
  ];
  const replayExecutor =
    options.replayExecutor ??
    (config.REPLAY_IMAGE_ID || config.REPLAY_APPS_FILE || replayApps.apps.length
      ? createDockerExecutor(
          artifacts,
          (id) =>
            replayApps.apps
              .flatMap((entry) => entry.backups ?? [])
              .find((row) => row.artifactId === id)?.reference,
        )
      : undefined);
  let registryStamp = config.REPLAY_APPS_FILE
    ? statSync(config.REPLAY_APPS_FILE).mtimeMs
    : 0;
  let nextRegistryCheck = 0;
  app.addHook('onRequest', async () => {
    if (!config.REPLAY_APPS_FILE || Date.now() < nextRegistryCheck) return;
    nextRegistryCheck = Date.now() + 1000;
    try {
      const stamp = statSync(config.REPLAY_APPS_FILE).mtimeMs;
      if (stamp === registryStamp) return;
      const updated = readReplayApps(config.REPLAY_APPS_FILE);
      const nextArtifacts = [
        ...new Set([
          ...(config.REPLAY_IMAGE_ID ? [config.REPLAY_IMAGE_ID] : []),
          ...(config.REPLAY_IMAGE_IDS?.split(',') ?? []),
          ...updated.apps.flatMap((entry) => entry.artifacts),
        ]),
      ];
      replayApps.apps = updated.apps;
      artifacts.splice(0, artifacts.length, ...nextArtifacts);
      registryStamp = stamp;
      logger.info({ operation: 'replay.registry.reload' }, 'Replay registry reloaded');
    } catch {
      nextRegistryCheck = Date.now() + 10000;
      logger.warn(
        { operation: 'replay.registry.reload' },
        'Replay registry update invalid or unavailable; retaining the last valid registration',
      );
    }
  });
  const replay = createReplayService(
    store,
    replayExecutor,
    artifacts,
    config.REPLAY_IMAGE_ID,
    replayApps,
  );
  const workspace = await createWorkspace(
    config,
    store,
    replayApps.apps.map((app) => app.service),
  );
  workspace.install(app);
  app.get('/v1/replay/retention', { onRequest: workspace.auth }, async (request) => {
    if (workspace.enabled) await workspace.authorizeAdmin(request);
    if (!store.replayArtifactReferences) throw new ApiError(503, 'REPLAY_UNAVAILABLE');
    const references = await store.replayArtifactReferences();
    return {
      builds: replayApps.apps.flatMap((entry) =>
        entry.artifacts.map((artifactId) => {
          const reference = references.find(
            (row) => row.artifactId === artifactId && row.service === entry.service,
          );
          return {
            artifactId,
            service: entry.service,
            current: artifactId === entry.currentArtifactId,
            protected: artifactId === entry.currentArtifactId || !!reference,
            captures: reference?.captures ?? 0,
            retainUntil: reference?.retainUntil ?? null,
          };
        }),
      ),
      unregisteredReferences: references.filter(
        (row) =>
          !replayApps.apps.some(
            (entry) =>
              entry.service === row.service && entry.artifacts.includes(row.artifactId),
          ),
      ),
    };
  });
  app.get('/v1/replay/readiness', { onRequest: workspace.auth }, async (request) => {
    const query = request.query as { service?: string; artifactId?: string };
    if (
      !query.service ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(query.service) ||
      !/^sha256:[a-f0-9]{64}$/.test(query.artifactId ?? '')
    )
      throw new ApiError(400, 'INVALID_REQUEST');
    workspace.assertIngest(request, query.service);
    const registered = replayApps.apps.find((entry) => entry.service === query.service);
    return {
      registered: !!registered?.artifacts.includes(query.artifactId!),
      runnerEnabled: !!replayExecutor,
    };
  });
  const alerts = await createNotificationSettings(config, store, logger);
  alerts.install(app, workspace.auth);
  app.addHook('onReady', async () => {
    alerts.start();
  });
  installRoutes(app, {
    get alertsEnabled() {
      return alerts.enabled;
    },
    get alertChannels() {
      return alerts.channels;
    },
    store,
    replay,
    registry: replayApps,
    token,
    auth: workspace.auth,
    access: workspace,
    isDraining: () => draining,
  });
  app.addHook('onClose', async () => {
    await alerts.stop();
    await replayExecutor?.close();
    await store.close();
  });
  const shutdown = createShutdown(
    app,
    () => {
      draining = true;
    },
    config.SHUTDOWN_TIMEOUT_MS,
  );
  return { app, shutdown };
}
