import { PROJECT_COOKIE } from '../../../lib/project';
import { cookies } from 'next/headers';
import { workspaceSession } from '../../../lib/session';
import { NextResponse } from 'next/server';
import { dashboardConfig } from '../../../lib/config';
import { COOKIE_NAME } from '../../../lib/session';
export async function POST(request: Request) {
  const config = dashboardConfig();
  if (request.headers.get('origin') !== config.origin)
    return new Response('Forbidden', { status: 403 });
  if (config.WORKSPACE_AUTH_MODE === 'accounts') {
    const session = workspaceSession(
      (await cookies()).get(COOKIE_NAME)?.value,
      config.DASHBOARD_SESSION_SECRET,
    );
    if (session)
      try {
        await fetch(`${config.collector}/v1/workspace/logout`, {
          method: 'POST',
          headers: { authorization: `Bearer ${session}` },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        /* The browser cookie is still cleared when the collector is unavailable. */
      }
  }
  const response =
    request.headers.get('accept') === 'application/json'
      ? NextResponse.json({ ok: true })
      : NextResponse.redirect(new URL('/login', config.origin), 303);
  response.cookies.set(PROJECT_COOKIE, '', {
    httpOnly: true,
    secure: config.secureCookie,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  response.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: config.secureCookie,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  return response;
}
