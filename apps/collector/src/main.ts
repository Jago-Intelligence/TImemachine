import { parseServerConfig } from '@timemachine/config';
import { createLogger } from '@timemachine/logger';
import { createConfiguredStore } from './configured-store.js';
import { createCollector } from './server.js';
import { installSignalHandlers } from './shutdown.js';

const startupLogger = createLogger({ service: 'collector' });

async function main() {
  const config = parseServerConfig(process.env);
  if (!config.TIMEMACHINE_AUTH_TOKEN)
    throw new Error('Collector authentication token is required');
  const logger = createLogger({ service: 'collector', level: config.LOG_LEVEL });
  const store = createConfiguredStore(config);
  if (!(await store.isReady())) {
    await store.close();
    throw new Error(
      'Collector storage is not ready; check migrations and database availability',
    );
  }
  const { app, shutdown } = await createCollector({ config, store, logger }).catch(
    async () => {
      await store.close();
      throw new Error('Collector initialization failed');
    },
  );
  const removeSignals = installSignalHandlers(shutdown, () => {
    logger.fatal(
      { operation: 'collector.shutdown', errorCode: 'SHUTDOWN_FAILED' },
      'Collector shutdown failed',
    );
    process.exit(1);
  });
  app.addHook('onClose', async () => {
    removeSignals();
  });
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    if (config.STORAGE_DRIVER === 'memory') {
      logger.warn(
        { storage: 'memory', operation: 'collector.startup' },
        'Incident storage is temporary and lost on restart',
      );
    } else {
      logger.info(
        { storage: 'postgres', operation: 'collector.startup' },
        'Collector using durable PostgreSQL storage',
      );
    }
  } catch {
    removeSignals();
    await shutdown();
    throw new Error('Collector listen failed');
  }
}

void main().catch(() => {
  startupLogger.fatal(
    { operation: 'collector.startup', errorCode: 'STARTUP_FAILED' },
    'Collector startup failed; check configuration and listener availability',
  );
  process.exitCode = 1;
});
