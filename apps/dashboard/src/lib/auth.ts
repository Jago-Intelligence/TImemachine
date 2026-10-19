import 'server-only';
import { cache } from 'react';
import { selectProject, PROJECT_COOKIE, type Project } from './project';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { dashboardConfig } from './config';
import { COOKIE_NAME, validSession, workspaceSession } from './session';
export const requireSession = cache(async function requireSession() {
  const config = dashboardConfig();
  if (
    !validSession(
      (await cookies()).get(COOKIE_NAME)?.value,
      config.DASHBOARD_SESSION_SECRET,
    )
  )
    redirect('/login');
  if (config.WORKSPACE_AUTH_MODE === 'accounts') {
    const session = workspaceSession(
      (await cookies()).get(COOKIE_NAME)?.value,
      config.DASHBOARD_SESSION_SECRET,
    );
    if (!session) redirect('/login');
    let response: Response;
    try {
      response = await fetch(`${config.collector}/v1/workspace/me`, {
        headers: { authorization: `Bearer ${session}` },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error('Workspace authentication unavailable');
    }
    if (response.status === 401) redirect('/login');
    if (!response.ok) throw new Error('Workspace authentication unavailable');
    const result = await response.json();
    if (!['admin', 'developer'].includes(result?.user?.role))
      throw new Error('Invalid workspace session');
    return {
      ...config,
      TIMEMACHINE_AUTH_TOKEN: session,
      role: result.user.role as 'admin' | 'developer',
      user: result.user as { id: string; email: string; role: 'admin' | 'developer' },
      projects: result.projects as Project[],
      activeProject: selectProject(
        result.projects as Project[],
        (await cookies()).get(PROJECT_COOKIE)?.value,
      ),
    };
  }
  return {
    ...config,
    role: 'admin' as const,
    user: undefined,
    projects: undefined,
    activeProject: undefined,
  };
});
