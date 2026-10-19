import { NextResponse } from 'next/server';
import { requireSession } from '../../../lib/auth';
async function proxy(request: Request, method: string) {
  const config = await requireSession();
  if (config.role !== 'admin')
    return NextResponse.json(
      { error: 'Administrator access required.' },
      { status: 403 },
    );
  if (method !== 'GET' && request.headers.get('origin') !== config.origin)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  let body: string | undefined;
  if (method !== 'GET') {
    if (
      !request.headers.get('content-type')?.startsWith('application/json') ||
      !request.body
    )
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const reader = request.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 16384) {
          await reader.cancel();
          throw new Error('Too large');
        }
        chunks.push(part.value);
      }
      body = Buffer.concat(chunks).toString('utf8');
      JSON.parse(body);
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const response = await fetch(
      `${config.collector}/v1/notifications${method === 'POST' ? '/test' : ''}`,
      {
        method,
        ...(body ? { body } : {}),
        headers: {
          authorization: `Bearer ${config.TIMEMACHINE_AUTH_TOKEN}`,
          'content-type': 'application/json',
        },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) {
      let detail = '';
      if (response.status === 400) {
        const rejected = await response.json().catch(() => ({}));
        const fields = rejected?.error?.fields;
        if (Array.isArray(fields))
          detail =
            ' Fields: ' +
            fields
              .filter(
                (field: unknown) => typeof field === 'string' && /^[A-Z_]+$/.test(field),
              )
              .slice(0, 20)
              .join(', ');
      }
      return NextResponse.json(
        {
          error:
            response.status === 409
              ? 'Settings changed. Reload before saving.'
              : method === 'POST'
                ? 'Test delivery failed. Check the provider and saved settings.'
                : 'Unable to save settings. Check selected destinations and SMTP fields.' +
                  detail,
        },
        { status: response.status },
      );
    }
    return NextResponse.json(await response.json(), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Collector unavailable.' }, { status: 503 });
  }
}
export async function GET(request: Request) {
  return proxy(request, 'GET');
}
export async function PUT(request: Request) {
  return proxy(request, 'PUT');
}
export async function POST(request: Request) {
  return proxy(request, 'POST');
}
