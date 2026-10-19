import { describe, expect, it } from 'vitest';
import { createLogger, withRequestContext } from '../src/index.js';

function capture(level: 'info' | 'silent' = 'info') {
  const lines: string[] = [];
  const logger = createLogger(
    { service: 'collector', level },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}

describe('structured logging', () => {
  it('records service, request and correlation identifiers', () => {
    const { logger, lines } = capture();
    withRequestContext(logger, {
      requestId: 'request-1',
      correlationId: 'incident-1',
    }).info({ statusCode: 500 }, 'Request failed');
    expect(JSON.parse(lines[0]!)).toMatchObject({
      service: 'collector',
      requestId: 'request-1',
      correlationId: 'incident-1',
      statusCode: 500,
      level: 30,
      msg: 'Request failed',
    });
  });

  it('removes credentials, payloads and unsafe error details', () => {
    const { logger, lines } = capture();
    logger.error(
      {
        token: 'top-secret',
        req: { headers: { authorization: 'Bearer private' }, body: 'sensitive' },
        payload: { password: 'private-password' },
        err: new Error('secret-in-message'),
      },
      'Incident ingestion failed',
    );
    const output = lines.join('');
    for (const secret of [
      'top-secret',
      'Bearer private',
      'sensitive',
      'private-password',
      'secret-in-message',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({ err: { type: 'Error' } });
  });

  it('respects the configured level', () => {
    const { logger, lines } = capture();
    logger.debug('Hidden');
    expect(lines).toHaveLength(0);
    const silent = capture('silent');
    silent.logger.fatal('Hidden');
    expect(silent.lines).toHaveLength(0);
  });
});
