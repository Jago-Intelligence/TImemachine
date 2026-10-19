// Fix this field to 'rate_per_km', then restart pnpm demo.
const DATABASE_RATE_FIELD = 'rate_per_km';
export const databaseRevision = DATABASE_RATE_FIELD === 'rate_per_km' ? 'fixed' : 'buggy';
export const zoneRateQuery =
  'SELECT rate_per_km, currency FROM delivery_zones WHERE zone_code = $1';

export function attachDatabaseQuote(app, database) {
  app.post('/delivery/zone-quote', async (request, response, next) => {
    const { distanceKm, zoneCode } = request.body ?? {};
    if (
      typeof distanceKm !== 'number' ||
      !Number.isFinite(distanceKm) ||
      distanceKm <= 0 ||
      distanceKm > 1000 ||
      !['LOCAL', 'EXPRESS'].includes(zoneCode)
    )
      return response.status(400).json({
        error: {
          code: 'INVALID_ZONE_QUOTE',
          message: 'Choose a valid distance and delivery zone.',
        },
      });
    if (!database)
      return response.status(503).json({ error: { code: 'DATABASE_NOT_CONFIGURED' } });
    try {
      const result = await database.query(zoneRateQuery, [zoneCode]);
      const row = result.rows[0];
      if (!row) return response.status(404).json({ error: { code: 'ZONE_NOT_FOUND' } });
      const rate = Number(row[DATABASE_RATE_FIELD].toFixed(2));
      response.json({
        quote: {
          distanceKm,
          zoneCode,
          ratePerKm: rate,
          fee: Math.round(rate * distanceKm * 100) / 100,
          currency: row.currency,
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
