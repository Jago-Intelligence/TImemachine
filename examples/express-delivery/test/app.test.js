import { expect, it, vi } from 'vitest';
import { createDeliveryApp, calculateFee } from '../src/app.js';

function handler(app, path, method) {
  return app.router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  ).route.stack[0].handle;
}
function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() };
}
it('validates distance without calling pricing', async () => {
  const original = globalThis.fetch;
  const fetch = vi.fn();
  globalThis.fetch = fetch;
  try {
    const quote = handler(createDeliveryApp(), '/delivery/quote', 'post');
    for (const distanceKm of [0, -1, '10', null, 1001]) {
      const reply = response();
      await quote({ body: { distanceKm } }, reply, vi.fn());
      expect(reply.status).toHaveBeenCalledWith(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = original;
  }
});
it('shows the intentional error or the documented corrected fee using the real handler', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () =>
    globalThis.Response.json({ ratePerKm: 2, currency: 'USD' }),
  );
  try {
    const reply = response(),
      next = vi.fn();
    await handler(createDeliveryApp(), '/delivery/quote', 'post')(
      { body: { distanceKm: 10 } },
      reply,
      next,
    );
    if (next.mock.calls.length) expect(next.mock.calls[0][0]).toBeInstanceOf(TypeError);
    else {
      expect(reply.json).toHaveBeenCalledWith({
        quote: { distanceKm: 10, ratePerKm: 2, fee: 20, currency: 'USD' },
      });
      expect(calculateFee({ ratePerKm: 2, currency: 'USD' }, 2.5).fee).toBe(5);
    }
  } finally {
    globalThis.fetch = original;
  }
});
it('handles an actual pricing service failure separately from the code bug', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new globalThis.Response(null, { status: 503 }));
  try {
    const reply = response();
    await handler(createDeliveryApp(), '/delivery/quote', 'post')(
      { body: { distanceKm: 10 } },
      reply,
      vi.fn(),
    );
    expect(reply.status).toHaveBeenCalledWith(503);
  } finally {
    globalThis.fetch = original;
  }
});
