import { expect, it, vi } from 'vitest';
import { createDeliveryApp } from '../src/app.js';
import { zoneRateQuery } from '../src/database-app.js';
function handler(database) {
  return createDeliveryApp({ database }).router.stack.find(
    (layer) => layer.route?.path === '/delivery/zone-quote',
  ).route.stack[0].handle;
}
function reply() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() };
}
it('binds request zone as a PostgreSQL parameter and keeps the code bug visible', async () => {
  const database = {
    query: vi.fn(async () => ({ rows: [{ rate_per_km: 4, currency: 'USD' }] })),
  };
  const response = reply(),
    next = vi.fn();
  await handler(database)(
    { body: { distanceKm: 10, zoneCode: 'EXPRESS' } },
    response,
    next,
  );
  expect(database.query).toHaveBeenCalledWith(zoneRateQuery, ['EXPRESS']);
  if (next.mock.calls.length) expect(next.mock.calls[0][0]).toBeInstanceOf(TypeError);
  else
    expect(response.json).toHaveBeenCalledWith({
      quote: {
        distanceKm: 10,
        zoneCode: 'EXPRESS',
        ratePerKm: 4,
        fee: 40,
        currency: 'USD',
      },
    });
});
it('rejects invalid zones before database access and reports missing zones', async () => {
  const database = { query: vi.fn(async () => ({ rows: [] })) };
  const invalid = reply();
  await handler(database)(
    { body: { distanceKm: 10, zoneCode: 'PRIVATE' } },
    invalid,
    vi.fn(),
  );
  expect(invalid.status).toHaveBeenCalledWith(400);
  expect(database.query).not.toHaveBeenCalled();
  const missing = reply();
  await handler(database)(
    { body: { distanceKm: 10, zoneCode: 'LOCAL' } },
    missing,
    vi.fn(),
  );
  expect(missing.status).toHaveBeenCalledWith(404);
});
