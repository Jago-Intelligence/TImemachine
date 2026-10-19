import { readLoginForm } from '../../../lib/http';
import { NextResponse } from 'next/server';
import { dashboardConfig } from '../../../lib/config';
import {
  allowLogin,
  COOKIE_NAME,
  createSession,
  passwordMatches,
  SESSION_SECONDS,
} from '../../../lib/session';
export async function POST(request: Request) {
  const config = dashboardConfig();
  if (request.headers.get('origin') !== config.origin)
    return new Response('Forbidden', { status: 403 });
  if (config.WORKSPACE_AUTH_MODE !== 'accounts' && !allowLogin())
    return new Response('Too many sign-in attempts. Try again in a minute.', {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
  const data = await readLoginForm(request);
  if (!data) return new Response('Invalid form', { status: 400 });
  const password = data.get('password') ?? '';
  const json = request.headers.get('accept') === 'application/json';
  let session: string | undefined;
  if (config.WORKSPACE_AUTH_MODE === 'accounts') {
    try {
      const result = await fetch(`${config.collector}/v1/workspace/login`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.TIMEMACHINE_AUTH_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: data.get('email') ?? '', password }),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!result.ok)
        return NextResponse.json(
          { ok: false },
          { status: result.status === 429 ? 429 : 401 },
        );
      const body = await result.json();
      if (typeof body.session !== 'string' || !/^ws_[a-f0-9]{64}$/.test(body.session))
        throw new Error();
      session = body.session;
    } catch {
      return NextResponse.json({ ok: false }, { status: 503 });
    }
  } else {
    if (
      data.getAll('password').length !== 1 ||
      !passwordMatches(password, config.DASHBOARD_PASSWORD)
    )
      return json
        ? NextResponse.json({ ok: false }, { status: 401 })
        : NextResponse.redirect(new URL('/login?error=credentials', config.origin), 303);
  }
  const response = json
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(new URL('/', config.origin), 303);
  response.cookies.set(
    COOKIE_NAME,
    createSession(config.DASHBOARD_SESSION_SECRET, Date.now(), session),
    {
      httpOnly: true,
      secure: config.secureCookie,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_SECONDS,
    },
  );
  return response;
}
