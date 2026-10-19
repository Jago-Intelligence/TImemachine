import { attachRegistration } from './registration-app.js';
import { attachDatabaseQuote, databaseRevision } from './database-app.js';
import express from 'express';
import { URL, fileURLToPath } from 'node:url';

// Fix this field to 'ratePerKm', then restart pnpm demo.
const RATE_FIELD = 'ratePerKm';

export function calculateFee(pricing, distanceKm) {
  const rate = Number(pricing[RATE_FIELD].toFixed(2));
  return {
    distanceKm,
    ratePerKm: rate,
    fee: Math.round(rate * distanceKm * 100) / 100,
    currency: pricing.currency,
  };
}
export function createDeliveryApp({
  dashboardOrigin = 'http://127.0.0.1:4321',
  database,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '2kb', inflate: false }));
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/demo-info', (_request, response) =>
    response.json({
      revision: RATE_FIELD === 'ratePerKm' ? 'fixed' : 'buggy',
      dashboardOrigin,
      databaseRevision,
      ratePerKm: 2,
      currency: 'USD',
    }),
  );
  app.post('/delivery/quote', async (request, response, next) => {
    const distance = request.body?.distanceKm;
    if (
      typeof distance !== 'number' ||
      !Number.isFinite(distance) ||
      distance <= 0 ||
      distance > 1000
    )
      return response.status(400).json({
        error: {
          code: 'INVALID_DISTANCE',
          message: 'Enter a distance greater than 0 and at most 1,000 km.',
        },
      });
    try {
      const result = await globalThis.fetch('http://127.0.0.1:4330/rates', {
        signal: globalThis.AbortSignal.timeout(2000),
      });
      if (!result.ok)
        return response.status(503).json({
          error: {
            code: 'PRICING_UNAVAILABLE',
            message: 'Pricing is temporarily unavailable.',
          },
        });
      response.json({ quote: calculateFee(await result.json(), distance) });
    } catch (error) {
      next(error);
    }
  });
  attachDatabaseQuote(app, database);
  attachRegistration(app, database);
  app.use(
    express.static(fileURLToPath(new URL('../public', import.meta.url)), { etag: false }),
  );
  app.use((error, _request, response, next) => {
    void next;
    const status = [400, 413, 415].includes(error?.status) ? error.status : 500;
    response.status(status).json({
      error: {
        code: status < 500 ? 'INVALID_REQUEST' : 'DELIVERY_QUOTE_FAILED',
        message:
          status < 500
            ? 'Check the request input.'
            : 'Unable to calculate the delivery fee.',
      },
    });
  });
  return app;
}

export function createPricingApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.get('/rates', (_request, response) =>
    response.json({ ratePerKm: 2, currency: 'USD' }),
  );
  return app;
}
