import type { SdkConfig } from './options.js';

export interface PendingIncident {
  id: string;
  correlationId: string;
  body: string;
  bytes: number;
}

type Attempt = { status: 'delivered' | 'failed' | 'retry'; delayMs?: number };

async function acknowledged(response: Response, id: string): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) return false;
      chunks.push(chunk.value);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return false;
    }
    return (
      typeof body === 'object' &&
      body !== null &&
      'apiVersion' in body &&
      body.apiVersion === 1 &&
      'incidentId' in body &&
      body.incidentId === id &&
      'status' in body &&
      (body.status === 'accepted' || body.status === 'duplicate')
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function attempt(
  config: SdkConfig,
  incident: PendingIncident,
  signal: AbortSignal,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  timer.unref();
  try {
    const response = await fetch(`${config.collectorUrl}/v1/incidents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        'x-correlation-id': incident.correlationId,
      },
      body: incident.body,
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, signal]),
    });
    if (response.status === 200 || response.status === 201) {
      return {
        status: (await acknowledged(response, incident.id)) ? 'delivered' : 'failed',
      };
    }
    await response.body?.cancel();
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      const seconds = Number(response.headers.get('retry-after'));
      const delayMs =
        Number.isFinite(seconds) && seconds > 0
          ? Math.min(seconds * 1000, 5000)
          : undefined;
      return { status: 'retry', ...(delayMs === undefined ? {} : { delayMs }) };
    }
    return { status: 'failed' };
  } catch {
    return { status: signal.aborted ? 'failed' : 'retry' };
  } finally {
    clearTimeout(timer);
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function deliver(
  config: SdkConfig,
  incident: PendingIncident,
  signal: AbortSignal,
): Promise<boolean> {
  for (let retry = 0; retry <= config.maxRetries && !signal.aborted; retry++) {
    const result = await attempt(config, incident, signal);
    if (result.status === 'delivered') return true;
    if (result.status === 'failed' || retry === config.maxRetries) return false;
    await pause(
      result.delayMs ?? Math.min(config.retryDelayMs * 2 ** retry, 5000),
      signal,
    );
  }
  return false;
}
