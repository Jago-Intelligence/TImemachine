import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import type { ServerConfig } from '@timemachine/config';
import type { IncidentStore } from '@timemachine/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { ApiError } from './errors.js';
function body(request: FastifyRequest): unknown {
  try {
    return typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
  } catch {
    return undefined;
  }
}
const role = z.enum(['admin', 'developer']);
const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const password = z.string().min(12).max(256);
const projectSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
});
const userSchema = z.strictObject({
  id: z.uuid(),
  email,
  role,
  enabled: z.boolean(),
  projects: z.array(z.uuid()).max(50),
  salt: z.string().length(32),
  hash: z.string().length(128),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  users: z.array(userSchema).max(50),
  projects: z.array(projectSchema).max(50),
  tokens: z
    .array(
      z.strictObject({
        id: z.uuid(),
        projectId: z.uuid(),
        label: z.string().min(1).max(80),
        hash: z.string().length(64),
        prefix: z.string(),
        createdAt: z.string(),
        revoked: z.boolean(),
      }),
    )
    .max(200),
  loginAttempts: z
    .array(
      z.strictObject({
        key: z.string().length(64),
        count: z.number().int().min(1).max(20),
        expiresAt: z.number().int(),
      }),
    )
    .max(1050)
    .default([]),
  sessions: z
    .array(
      z.strictObject({
        hash: z.string().length(64),
        userId: z.uuid(),
        expiresAt: z.number().int(),
      }),
    )
    .max(250),
});
type State = z.infer<typeof stateSchema>;
type User = z.infer<typeof userSchema>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function derive(value: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(
      value,
      Buffer.from(salt, 'hex'),
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
async function encodedPassword(value: string) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await derive(value, salt)).toString('hex') };
}
function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    enabled: user.enabled,
    projects: user.projects,
  };
}
export async function createWorkspace(
  config: ServerConfig,
  store: IncidentStore,
  services: readonly string[] = [],
) {
  const enabled = config.WORKSPACE_AUTH_MODE === 'accounts';
  const principals = new WeakMap<
    FastifyRequest,
    { user?: User; service?: string; token: string }
  >();
  const rootAuth = authenticate(config.TIMEMACHINE_AUTH_TOKEN!);
  async function read() {
    const row = await store.getWorkspace();
    if (!row) throw new ApiError(503, 'STORE_UNAVAILABLE');
    return { revision: row.revision, state: stateSchema.parse(JSON.parse(row.document)) };
  }
  async function mutate<T>(action: (state: State) => T) {
    for (let i = 0; i < 8; i++) {
      const { revision, state } = await read();
      state.sessions = state.sessions.filter((item) => item.expiresAt > Date.now());
      const result = action(state);
      stateSchema.parse(state);
      if (await store.saveWorkspace(JSON.stringify(state), revision)) return result;
    }
    throw new ApiError(409, 'WORKSPACE_CONFLICT');
  }
  if (enabled && !(await store.getWorkspace())) {
    const initial: State = {
      version: 1,
      users: [
        {
          id: randomUUID(),
          email: email.parse(config.WORKSPACE_ADMIN_EMAIL),
          role: 'admin',
          enabled: true,
          projects: [],
          ...(await encodedPassword(password.parse(config.WORKSPACE_ADMIN_PASSWORD))),
        },
      ],
      projects: [...new Set(services)].map((service) =>
        projectSchema.parse({ id: randomUUID(), name: service, service }),
      ),
      tokens: [],
      sessions: [],
      loginAttempts: [],
    };
    await store.saveWorkspace(JSON.stringify(initial), 0);
  }
  function header(request: FastifyRequest) {
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer ') || value.length > 300)
      throw new ApiError(401, 'UNAUTHORIZED');
    return value.slice(7);
  }
  async function actor(request: FastifyRequest) {
    const token = header(request);
    const { state } = await read();
    const session = state.sessions.find(
      (s) => s.hash === hash(token) && s.expiresAt > Date.now(),
    );
    const user = state.users.find((u) => u.id === session?.userId && u.enabled);
    if (!user) throw new ApiError(401, 'UNAUTHORIZED');
    return { user, state, token };
  }
  async function admin(request: FastifyRequest) {
    const value = await actor(request);
    if (value.user.role !== 'admin') throw new ApiError(403, 'FORBIDDEN');
    return value;
  }
  async function adminMutate<T>(request: FastifyRequest, action: (state: State) => T) {
    const token = header(request);
    return mutate((state) => {
      const session = state.sessions.find(
        (item) => item.hash === hash(token) && item.expiresAt > Date.now(),
      );
      const user = state.users.find(
        (item) => item.id === session?.userId && item.enabled && item.role === 'admin',
      );
      if (!user) throw new ApiError(403, 'FORBIDDEN');
      return action(state);
    });
  }
  function servicesFor(user: User, state: State) {
    return user.role === 'admin'
      ? undefined
      : state.projects.filter((p) => user.projects.includes(p.id)).map((p) => p.service);
  }
  async function authenticateRequest(request: FastifyRequest) {
    if (!enabled) return rootAuth(request);
    const token = header(request),
      path = request.routeOptions.url;
    if (token.startsWith('tm_')) {
      const { state } = await read();
      const entry = state.tokens.find((t) => !t.revoked && t.hash === hash(token));
      const project = state.projects.find((p) => p.id === entry?.projectId);
      if (!project) throw new ApiError(401, 'UNAUTHORIZED');
      if (
        !(request.method === 'POST' && path === '/v1/incidents') &&
        !(request.method === 'GET' && path === '/v1/workspace/token') &&
        !(request.method === 'GET' && path === '/v1/replay/readiness')
      )
        throw new ApiError(403, 'FORBIDDEN');
      principals.set(request, { service: project.service, token });
      return;
    }
    const { user, state } = await actor(request);
    if (request.method === 'POST' && path === '/v1/incidents')
      throw new ApiError(403, 'FORBIDDEN');
    const selection = request.headers['x-timemachine-project'];
    let selectedService: string | undefined;
    if (selection !== undefined) {
      if (typeof selection !== 'string' || !z.uuid().safeParse(selection).success)
        throw new ApiError(400, 'INVALID_REQUEST');
      const selected = state.projects.find((project) => project.id === selection);
      if (!selected || (user.role !== 'admin' && !user.projects.includes(selected.id)))
        throw new ApiError(403, 'FORBIDDEN');
      selectedService = selected.service;
    }
    principals.set(request, {
      user,
      token,
      ...(selectedService ? { service: selectedService } : {}),
    });
    if (user.role === 'admin' && !selectedService) return;
    if (
      user.role !== 'admin' &&
      (path?.startsWith('/v1/notifications') || path === '/v1/alerts/status')
    )
      throw new ApiError(403, 'FORBIDDEN');
    const allowed = selectedService ? [selectedService] : servicesFor(user, state)!;
    const params = request.params as { id?: string };
    if (
      path?.startsWith('/v1/incidents/') &&
      params.id &&
      z.uuid().safeParse(params.id).success
    ) {
      const incident = await store.get(params.id.toLowerCase());
      if (incident && !allowed.includes(incident.service.name))
        throw new ApiError(404, 'INCIDENT_NOT_FOUND');
    }
    if (
      path?.startsWith('/v1/issues/') &&
      params.id &&
      /^[a-f0-9]{64}$/.test(params.id)
    ) {
      const issue = await store.getIssue(params.id, { limit: 1 });
      if (issue && !allowed.includes(issue.issue.service.name))
        throw new ApiError(404, 'ISSUE_NOT_FOUND');
    }
  }
  async function scope(request: FastifyRequest) {
    if (!enabled) return undefined;
    const principal = principals.get(request);
    if (!principal?.user) return [];
    const { state } = await read();
    const user = state.users.find((u) => u.id === principal.user!.id && u.enabled);
    if (!user) throw new ApiError(401, 'UNAUTHORIZED');
    const allowed = servicesFor(user, state);
    return principal.service
      ? allowed === undefined || allowed.includes(principal.service)
        ? [principal.service]
        : []
      : allowed;
  }
  return {
    enabled,
    authorizeAdmin: admin,
    auth: authenticateRequest,
    scope,
    credential: (request: FastifyRequest) =>
      principals.get(request)?.token ?? config.TIMEMACHINE_AUTH_TOKEN!,
    assertIngest(request: FastifyRequest, service: string) {
      if (enabled && principals.get(request)?.service !== service)
        throw new ApiError(403, 'FORBIDDEN');
    },
    install(app: FastifyInstance) {
      if (!enabled) {
        app.get('/v1/workspace/mode', async () => ({ mode: 'legacy' }));
        return;
      }
      app.get('/v1/workspace/mode', async () => ({ mode: 'accounts' }));
      app.post(
        '/v1/workspace/login',
        {
          onRequest: rootAuth,
          bodyLimit: 2048,
        },
        async (request) => {
          const parsed = z
            .strictObject({ email, password: z.string().max(256) })
            .safeParse(body(request));
          if (!parsed.success) throw new ApiError(401, 'UNAUTHORIZED');
          // Persist before password work: shared across replicas/restarts, scoped to
          // the normalized account, and never reset by a successful guess.
          await mutate((state) => {
            const now = Date.now();
            state.loginAttempts = state.loginAttempts.filter(
              (row) => row.expiresAt > now,
            );
            const key = hash(parsed.data.email);
            const row = state.loginAttempts.find((item) => item.key === key);
            if (row) {
              if (row.count >= 20) throw new ApiError(429, 'RATE_LIMIT_EXCEEDED');
              row.count++;
            } else {
              // Reserve capacity for all 50 workspace users so random unknown
              // identities cannot fill the budget table and block real accounts.
              const known = state.users.some((user) => user.email === parsed.data.email);
              if (state.loginAttempts.length >= (known ? 1050 : 1000))
                throw new ApiError(429, 'RATE_LIMIT_EXCEEDED');
              state.loginAttempts.push({ key, count: 1, expiresAt: now + 60000 });
            }
          });
          const { state } = await read();
          const user = state.users.find(
            (u) => u.email === parsed.data.email && u.enabled,
          );
          const derived = await derive(
            parsed.data.password,
            user?.salt ?? '0'.repeat(32),
          );
          if (!user || !timingSafeEqual(derived, Buffer.from(user.hash, 'hex')))
            throw new ApiError(401, 'UNAUTHORIZED');
          const session = 'ws_' + randomBytes(32).toString('hex');
          await mutate((s) => {
            const current = s.users.find(
              (u) => u.id === user.id && u.enabled && u.hash === user.hash,
            );
            if (!current) throw new ApiError(401, 'UNAUTHORIZED');
            if (s.sessions.length >= 250) throw new ApiError(429, 'RATE_LIMIT_EXCEEDED');
            s.sessions.push({
              hash: hash(session),
              userId: user.id,
              expiresAt: Date.now() + 8 * 60 * 60 * 1000,
            });
          });
          return { session, user: publicUser(user) };
        },
      );
      app.get(
        '/v1/workspace/token',
        { onRequest: authenticateRequest },
        async (request) => ({ service: principals.get(request)?.service }),
      );
      app.get('/v1/workspace/me', async (request) => {
        const { user, state } = await actor(request);
        return {
          user: publicUser(user),
          projects: state.projects.filter(
            (p) => user.role === 'admin' || user.projects.includes(p.id),
          ),
        };
      });
      app.post('/v1/workspace/logout', async (request) => {
        const { token } = await actor(request);
        await mutate((s) => {
          s.sessions = s.sessions.filter((item) => item.hash !== hash(token));
        });
        return { ok: true };
      });
      app.get('/v1/workspace', async (request) => {
        await admin(request);
        const { state, revision } = await read();
        return {
          revision,
          users: state.users.map(publicUser),
          projects: state.projects,
          tokens: state.tokens.map((token) => ({
            id: token.id,
            projectId: token.projectId,
            label: token.label,
            prefix: token.prefix,
            createdAt: token.createdAt,
            revoked: token.revoked,
          })),
        };
      });
      app.post('/v1/workspace/users', { bodyLimit: 8192 }, async (request) => {
        await admin(request);
        const input = z
          .strictObject({ email, password, role, projects: z.array(z.uuid()).max(50) })
          .safeParse(body(request));
        if (!input.success) throw new ApiError(400, 'INVALID_REQUEST');
        const encoded = await encodedPassword(input.data.password);
        return adminMutate(request, (s) => {
          if (
            s.users.some((u) => u.email === input.data.email) ||
            s.users.length >= 50 ||
            input.data.projects.some((id) => !s.projects.some((p) => p.id === id))
          )
            throw new ApiError(409, 'INVALID_REQUEST');
          const user = {
            id: randomUUID(),
            email: input.data.email,
            role: input.data.role,
            enabled: true,
            projects: input.data.projects,
            ...encoded,
          };
          s.users.push(user);
          return publicUser(user);
        });
      });
      app.put<{ Params: { id: string } }>(
        '/v1/workspace/users/:id',
        { bodyLimit: 8192 },
        async (request) => {
          await admin(request);
          const input = z
            .strictObject({
              role,
              enabled: z.boolean(),
              projects: z.array(z.uuid()).max(50),
              password: password.optional(),
            })
            .safeParse(body(request));
          if (!input.success) throw new ApiError(400, 'INVALID_REQUEST');
          const encoded = input.data.password
            ? await encodedPassword(input.data.password)
            : undefined;
          return adminMutate(request, (s) => {
            const user = s.users.find((u) => u.id === request.params.id);
            if (!user) throw new ApiError(404, 'NOT_FOUND');
            if (input.data.projects.some((id) => !s.projects.some((p) => p.id === id)))
              throw new ApiError(400, 'INVALID_REQUEST');
            Object.assign(
              user,
              {
                role: input.data.role,
                enabled: input.data.enabled,
                projects: input.data.projects,
              },
              encoded ?? {},
            );
            if (!s.users.some((u) => u.enabled && u.role === 'admin'))
              throw new ApiError(409, 'FORBIDDEN');
            if (encoded || !user.enabled)
              s.sessions = s.sessions.filter((session) => session.userId !== user.id);
            return publicUser(user);
          });
        },
      );
      app.post('/v1/workspace/projects', { bodyLimit: 2048 }, async (request) => {
        await admin(request);
        const input = projectSchema.omit({ id: true }).safeParse(body(request));
        if (!input.success) throw new ApiError(400, 'INVALID_REQUEST');
        return adminMutate(request, (s) => {
          if (
            s.projects.some((p) => p.service === input.data.service) ||
            s.projects.length >= 50
          )
            throw new ApiError(409, 'INVALID_REQUEST');
          const project = { id: randomUUID(), ...input.data };
          s.projects.push(project);
          return project;
        });
      });
      app.post<{ Params: { id: string } }>(
        '/v1/workspace/projects/:id/tokens',
        { bodyLimit: 2048 },
        async (request) => {
          await admin(request);
          const input = z
            .strictObject({ label: z.string().min(1).max(80) })
            .safeParse(body(request));
          if (!input.success) throw new ApiError(400, 'INVALID_REQUEST');
          const token = 'tm_' + randomBytes(32).toString('hex');
          return adminMutate(request, (s) => {
            if (
              !s.projects.some((p) => p.id === request.params.id) ||
              s.tokens.length >= 200
            )
              throw new ApiError(400, 'INVALID_REQUEST');
            const row = {
              id: randomUUID(),
              projectId: request.params.id,
              label: input.data.label,
              hash: hash(token),
              prefix: token.slice(0, 11),
              createdAt: new Date().toISOString(),
              revoked: false,
            };
            s.tokens.push(row);
            return { id: row.id, token };
          });
        },
      );
      app.delete<{ Params: { id: string } }>(
        '/v1/workspace/tokens/:id',
        async (request) => {
          await admin(request);
          await adminMutate(request, (s) => {
            const row = s.tokens.find((t) => t.id === request.params.id);
            if (!row) throw new ApiError(404, 'NOT_FOUND');
            row.revoked = true;
          });
          return { ok: true };
        },
      );
      app.post('/v1/workspace/password', { bodyLimit: 2048 }, async (request) => {
        const { user } = await actor(request);
        const input = z
          .strictObject({ currentPassword: z.string().max(256), newPassword: password })
          .safeParse(body(request));
        if (
          !input.success ||
          !timingSafeEqual(
            await derive(input.data.currentPassword, user.salt),
            Buffer.from(user.hash, 'hex'),
          )
        )
          throw new ApiError(401, 'UNAUTHORIZED');
        const encoded = await encodedPassword(input.data.newPassword);
        await mutate((s) => {
          const current = s.users.find((u) => u.id === user.id && u.hash === user.hash);
          if (!current) throw new ApiError(409, 'WORKSPACE_CONFLICT');
          Object.assign(current, encoded);
          s.sessions = s.sessions.filter((session) => session.userId !== user.id);
        });
        return { ok: true };
      });
    },
  };
}
