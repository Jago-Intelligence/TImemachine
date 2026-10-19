import pino, { type DestinationStream, type Logger, type LevelWithSilent } from 'pino';

export interface LoggerOptions {
  service: string;
  level?: LevelWithSilent;
}

export interface RequestContext {
  requestId: string;
  correlationId: string;
}

export function createLogger(
  options: LoggerOptions,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      name: options.service,
      level: options.level ?? 'info',
      base: { service: options.service },
      redact: {
        paths: [
          'password',
          'token',
          'secret',
          'authorization',
          'cookie',
          '*.password',
          '*.token',
          '*.secret',
          '*.authorization',
          '*.cookie',
          'headers',
          'req.headers',
          'request.headers',
          'body',
          'req.body',
          'request.body',
          'payload',
          'DATABASE_URL',
          'TIMEMACHINE_AUTH_TOKEN',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        // Error messages and stacks can contain request data or credentials.
        err: (error: unknown) => ({
          type: error instanceof Error ? 'Error' : 'UnknownError',
        }),
      },
    },
    destination,
  );
}

export function withRequestContext(logger: Logger, context: RequestContext): Logger {
  return logger.child({
    requestId: context.requestId,
    correlationId: context.correlationId,
  });
}
