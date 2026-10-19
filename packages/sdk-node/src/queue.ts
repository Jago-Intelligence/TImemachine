import { deliver, type PendingIncident } from './delivery.js';
import type { SdkConfig } from './options.js';
import type { CaptureResult, DeliveryStats } from './types.js';

function timeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 60000)
    throw new Error('Invalid SDK flush timeout');
  return value;
}

export function createQueue(config: SdkConfig) {
  const items: PendingIncident[] = [];
  const controller = new AbortController();
  const waiters = new Set<() => void>();
  let accepting = true;
  let running = false;
  let pendingBytes = 0;
  let delivered = 0;
  let failed = 0;
  let dropped = 0;
  let closing: Promise<boolean> | undefined;

  function notify() {
    if (items.length === 0) for (const finish of [...waiters]) finish();
  }
  async function drain() {
    running = true;
    try {
      while (items.length && !controller.signal.aborted) {
        const item = items[0]!;
        const success = await deliver(config, item, controller.signal);
        if (controller.signal.aborted) break;
        items.shift();
        pendingBytes -= item.bytes;
        if (success) delivered++;
        else failed++;
      }
    } finally {
      running = false;
      notify();
    }
  }
  function flush(timeoutMs = 5000): Promise<boolean> {
    timeout(timeoutMs);
    if (!items.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(finish);
        resolve(false);
      }, timeoutMs);
      waiters.add(finish);
    });
  }
  return {
    enqueue(incident: PendingIncident): CaptureResult {
      if (!accepting) {
        dropped++;
        return { queued: false, reason: 'closed' };
      }
      if (
        items.length >= config.maxQueueSize ||
        pendingBytes + incident.bytes > config.maxQueueBytes
      ) {
        dropped++;
        return { queued: false, reason: 'queue-full' };
      }
      items.push(incident);
      pendingBytes += incident.bytes;
      if (!running) void drain();
      return { queued: true, incidentId: incident.id };
    },
    reject(): CaptureResult {
      dropped++;
      return { queued: false, reason: accepting ? 'invalid-context' : 'closed' };
    },
    isAccepting: () => accepting,
    flush,
    close(timeoutMs = 5000): Promise<boolean> {
      timeout(timeoutMs);
      if (closing) return closing;
      accepting = false;
      closing = (async () => {
        const drained = await flush(timeoutMs);
        if (!drained) {
          controller.abort();
          dropped += items.length;
          items.length = 0;
          pendingBytes = 0;
          notify();
        }
        return drained;
      })();
      return closing;
    },
    stats(): Readonly<DeliveryStats> {
      return Object.freeze({
        delivered,
        failed,
        dropped,
        pending: items.length,
        pendingBytes,
      });
    },
  };
}
