import { projectOverview, PROJECT_COOKIE } from '../../../../lib/project';
import { SESSION_SECONDS } from '../../../../lib/session';
import { NextResponse } from 'next/server';
import { requireSession } from '../../../../lib/auth';
async function proxy(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const config = await requireSession();
  const path = (await params).path.join('/');
  if (config.WORKSPACE_AUTH_MODE !== 'accounts')
    return NextResponse.json(
      { error: 'Enable account mode on the collector and dashboard first.' },
      { status: 409 },
    );
  if (
    !/^(me|users(?:\/[a-f0-9-]{36})?|projects(?:\/[a-f0-9-]{36}\/tokens)?|tokens\/[a-f0-9-]{36}|password|overview)$/.test(
      path,
    )
  )
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  if (path !== 'me' && path !== 'password' && config.role !== 'admin')
    return NextResponse.json(
      { error: 'Administrator access required.' },
      { status: 403 },
    );
  if (request.method !== 'GET' && request.headers.get('origin') !== config.origin)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const tokenProject = /^projects\/([a-f0-9-]{36})\/tokens$/.exec(path)?.[1];
  if (tokenProject && tokenProject !== config.activeProject?.id)
    return NextResponse.json(
      { error: 'Switch to this project before managing its tokens.' },
      { status: 403 },
    );
  let body: string | undefined;
  if (['POST', 'PUT'].includes(request.method)) {
    if (
      !request.body ||
      !request.headers.get('content-type')?.startsWith('application/json')
    )
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const reader = request.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 8192) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(next.value);
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
    if (request.method === 'DELETE' && path.startsWith('tokens/')) {
      const overview = await fetch(`${config.collector}/v1/workspace`, {
        headers: { authorization: `Bearer ${config.TIMEMACHINE_AUTH_TOKEN}` },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!overview.ok)
        return NextResponse.json(
          { error: 'Workspace unavailable.' },
          { status: overview.status },
        );
      const value = await overview.json();
      if (
        !value.tokens?.some(
          (token: { id: string; projectId: string }) =>
            token.id === path.slice(7) && token.projectId === config.activeProject?.id,
        )
      )
        return NextResponse.json(
          { error: 'Token unavailable in the selected project.' },
          { status: 404 },
        );
    }
    const response = await fetch(
      `${config.collector}/v1/workspace${path === 'overview' ? '' : '/' + path}`,
      {
        method: request.method,
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
    if (!response.ok)
      return NextResponse.json(
        {
          error:
            response.status === 401
              ? 'Session expired or password incorrect.'
              : response.status === 403
                ? 'This action is not permitted.'
                : response.status === 409
                  ? 'A conflicting account/project exists, or the last administrator would be removed.'
                  : 'Request rejected. Check fields, project assignments and workspace limits.',
        },
        { status: response.status },
      );
    const value = await response.json();
    const scoped =
      path === 'overview'
        ? projectOverview(value, config.activeProject)
        : path === 'me'
          ? {
              ...value,
              projects: value.projects.filter(
                (project: { id: string }) => project.id === config.activeProject?.id,
              ),
            }
          : value;
    const result = NextResponse.json(scoped, {
      headers: { 'cache-control': 'no-store' },
    });
    if (path === 'projects' && request.method === 'POST' && typeof value.id === 'string')
      result.cookies.set(PROJECT_COOKIE, value.id, {
        httpOnly: true,
        secure: config.secureCookie,
        sameSite: 'strict',
        path: '/',
        maxAge: SESSION_SECONDS,
      });
    return result;
  } catch {
    return NextResponse.json({ error: 'Workspace unavailable.' }, { status: 503 });
  }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
