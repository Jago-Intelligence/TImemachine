import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '../../../../lib/auth';
import { PROJECT_COOKIE } from '../../../../lib/project';
import { SESSION_SECONDS } from '../../../../lib/session';
export async function POST(request: Request) {
  const session = await requireSession();
  if (request.headers.get('origin') !== session.origin)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (session.WORKSPACE_AUTH_MODE !== 'accounts')
    return NextResponse.json(
      { error: 'Projects require account mode.' },
      { status: 409 },
    );
  if (
    !request.body ||
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const reader = request.body.getReader();
  let text = '',
    bytes = 0;
  let id: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 256) {
        await reader.cancel();
        throw new Error();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    id = z.strictObject({ projectId: z.uuid() }).parse(JSON.parse(text)).projectId;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  } finally {
    reader.releaseLock();
  }
  if (!session.projects?.some((project) => project.id === id))
    return NextResponse.json({ error: 'Project unavailable' }, { status: 403 });
  const response = NextResponse.json(
    { ok: true },
    { headers: { 'cache-control': 'no-store' } },
  );
  response.cookies.set(PROJECT_COOKIE, id, {
    httpOnly: true,
    secure: session.secureCookie,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
  return response;
}
