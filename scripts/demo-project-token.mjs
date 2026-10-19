import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  chmodSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
/** Local demo migration only: use a project token rather than the control-plane key. */
export async function ensureDemoProjectToken(env, service, path) {
  if (env.WORKSPACE_AUTH_MODE !== 'accounts') return env.TIMEMACHINE_AUTH_TOKEN;
  let current;
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf8')).authToken;
    } catch {
      throw new Error('Demo credentials file is invalid.');
    }
  }
  const base = env.TIMEMACHINE_COLLECTOR_URL;
  async function request(token, route, method = 'GET', body) {
    const response = await globalThis.fetch(base + route, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(
        'Project-token migration failed. Check the administrator credentials or issue a replacement project token in the dashboard.',
      );
    return response.json();
  }
  if (typeof current === 'string' && current.startsWith('tm_')) {
    const checked = await request(current, '/v1/workspace/token');
    if (checked.service !== service)
      throw new Error('Demo token belongs to another service.');
    return current;
  }
  const login = await request(env.TIMEMACHINE_AUTH_TOKEN, '/v1/workspace/login', 'POST', {
    email: env.WORKSPACE_ADMIN_EMAIL,
    password: env.WORKSPACE_ADMIN_PASSWORD,
  });
  try {
    const me = await request(login.session, '/v1/workspace/me');
    const project =
      me.projects.find((project) => project.service === service) ??
      (await request(login.session, '/v1/workspace/projects', 'POST', {
        name: service,
        service,
      }));
    const issued = await request(
      login.session,
      `/v1/workspace/projects/${project.id}/tokens`,
      'POST',
      { label: 'local-demo-backend' },
    );
    if (!/^tm_[a-f0-9]{64}$/.test(issued.token))
      throw new Error('Invalid project token response.');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID();
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ authToken: issued.token }, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return issued.token;
  } finally {
    await request(login.session, '/v1/workspace/logout', 'POST').catch(() => {});
  }
}
