import type { FastifyInstance } from 'fastify';

/** Stop accepting work, drain requests, then close store resources via onClose. */
export function createShutdown(
  app: FastifyInstance,
  beginDrain: () => void,
  timeoutMs: number,
) {
  let closing: Promise<void> | undefined;
  return function shutdown(): Promise<void> {
    if (closing) return closing;
    beginDrain();
    app.log.info({ operation: 'collector.shutdown' }, 'Collector shutdown started');
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          app.close(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              app.server.closeAllConnections();
              reject(new Error('Collector shutdown deadline exceeded'));
            }, timeoutMs);
          }),
        ]);
        app.log.info({ operation: 'collector.shutdown' }, 'Collector shutdown completed');
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  };
}

export function installSignalHandlers(
  shutdown: () => Promise<void>,
  onFailure: () => void,
): () => void {
  const handler = () => {
    void shutdown().catch(onFailure);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}
