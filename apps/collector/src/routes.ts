import type { createReplayService } from './replay-service.js';
import {
  generateRecordedReplay,
  parseIncident,
  NODE_HTTP_REPLAY_MODE,
  type ReplayAppRegistry,
  replayRequestSchema,
  parseIncidentJson,
  captureEnvelopeSchema,
  validateReplayBinding,
} from '@timemachine/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';
import { sanitizeIncident } from './sanitize.js';
import {
  parseIncidentListQuery,
  parseIssueListQuery,
  parseIssueOccurrenceQuery,
  issueIdSchema,
  resolveIssueSchema,
  type IncidentStore,
} from '@timemachine/storage';

interface RouteOptions {
  access?: Awaited<ReturnType<typeof import('./workspace.js').createWorkspace>>;
  store: IncidentStore;
  registry: ReplayAppRegistry;
  replay: ReturnType<typeof createReplayService>;
  token: string;
  alertsEnabled: boolean;
  alertChannels?: readonly import('@timemachine/storage').AlertChannel[];
  isDraining: () => boolean;
  auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function installRoutes(app: FastifyInstance, options: RouteOptions): void {
  async function accessOptions(request: FastifyRequest) {
    const allowedServices = await options.access?.scope(request);
    return allowedServices === undefined ? {} : { allowedServices };
  }
  app.get('/health/live', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
  }));
  app.get('/health/ready', { config: { rateLimit: false } }, async (request, reply) => {
    let ready = false;
    try {
      ready = !options.isDraining() && (await options.store.isReady());
    } catch {
      request.log.error(
        { operation: 'collector.readiness', errorCode: 'STORE_UNAVAILABLE' },
        'Readiness check failed',
      );
    }
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not-ready' });
  });
  app.post<{ Body: string }>(
    '/v1/incidents',
    {
      onRequest: async (request, reply) => {
        await options.auth(request, reply);
        const type = request.headers['content-type'];
        const encoding = request.headers['content-encoding'];
        if (
          typeof type !== 'string' ||
          !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type) ||
          (encoding !== undefined && encoding !== 'identity')
        ) {
          throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE');
        }
      },
    },
    async (request, reply) => {
      if (typeof request.body !== 'string') throw new ApiError(400, 'INVALID_JSON');
      let json: unknown;
      try {
        json = JSON.parse(request.body);
      } catch {
        throw new ApiError(400, 'INVALID_JSON');
      }
      const envelope =
        typeof json === 'object' && json !== null && 'captureVersion' in json
          ? captureEnvelopeSchema.safeParse(json)
          : undefined;
      if (envelope && !envelope.success)
        throw new ApiError(422, 'INVALID_REPLAY_FIXTURE');
      let incident = sanitizeIncident(
        parseIncidentJson(
          envelope?.success ? JSON.stringify(envelope.data.incident) : request.body,
        ),
        options.token,
      );
      options.access?.assertIngest(request, incident.service.name);
      const credential = options.access?.credential(request) ?? options.token;
      if (credential !== options.token) incident = sanitizeIncident(incident, credential);
      let fixture;
      if (envelope?.success) {
        try {
          fixture = validateReplayBinding(incident, envelope.data.replayFixture);
        } catch {
          throw new ApiError(422, 'INVALID_REPLAY_FIXTURE');
        }
        if (
          JSON.stringify(fixture).includes(options.token) ||
          JSON.stringify(fixture).includes(credential)
        )
          throw new ApiError(422, 'SENSITIVE_INCIDENT_METADATA');
      }
      if (!fixture && incident.recording) {
        const existing = await options.store.get(incident.id);
        const storedFixture = existing
          ? await options.store.getReplayFixture(incident.id)
          : undefined;
        if (storedFixture?.runner === 'express-app-v1' && storedFixture.recording) {
          incident = parseIncident({
            ...incident,
            adapter: {
              ...incident.adapter,
              capabilities: {
                ...incident.adapter.capabilities,
                replay: [
                  ...new Set([
                    ...incident.adapter.capabilities.replay,
                    NODE_HTTP_REPLAY_MODE,
                  ]),
                ],
              },
            },
            replay: {
              status: 'candidate',
              mode: NODE_HTTP_REPLAY_MODE,
              fixtureSetId: incident.id,
            },
          });
          fixture = validateReplayBinding(incident, {
            ...storedFixture,
            recording: incident.recording,
          });
        } else if (!existing) {
          const generated = generateRecordedReplay(incident, options.registry);
          if (generated.fixture) {
            incident = generated.incident;
            fixture = validateReplayBinding(incident, generated.fixture);
          }
        }
      }
      const result = await options.store.save(
        incident,
        fixture,
        options.alertChannels ?? options.alertsEnabled,
      );
      request.log.info(
        { incidentId: incident.id, result, operation: 'incident.ingest' },
        'Incident ingestion completed',
      );
      return reply
        .code(result === 'created' ? 201 : 200)
        .header('location', `/v1/incidents/${incident.id}`)
        .send({
          apiVersion: 1,
          incidentId: incident.id,
          status: result === 'created' ? 'accepted' : 'duplicate',
        });
    },
  );
  app.get<{ Params: { id: string } }>(
    '/v1/incidents/:id/replays',
    { onRequest: options.auth },
    async (request) => options.replay.info(request.params.id),
  );
  app.post<{ Params: { id: string }; Body: string }>(
    '/v1/incidents/:id/replays',
    { onRequest: options.auth, bodyLimit: 1024 },
    async (request, reply) => {
      let body: unknown;
      try {
        body = request.body ? JSON.parse(request.body) : {};
      } catch {
        throw new ApiError(400, 'INVALID_REQUEST');
      }
      const parsed = replayRequestSchema.safeParse(body);
      if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST');
      if (JSON.stringify(parsed.data).includes(options.token))
        throw new ApiError(422, 'SENSITIVE_INCIDENT_METADATA');
      return reply
        .code(201)
        .send(
          await options.replay.run(
            request.params.id,
            parsed.data.mode,
            parsed.data.target,
          ),
        );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/v1/issues/:id/resolve',
    { onRequest: options.auth },
    async (request) => {
      if (!issueIdSchema.safeParse(request.params.id).success)
        throw new ApiError(400, 'INVALID_ISSUE_ID');
      let body: unknown;
      try {
        if (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 512)
          throw new Error('Invalid body');
        body = JSON.parse(request.body);
      } catch {
        throw new ApiError(400, 'INVALID_REQUEST');
      }
      const parsed = resolveIssueSchema.safeParse(body);
      if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST');
      return {
        apiVersion: 1,
        ...(await options.store.resolveIssue(request.params.id, parsed.data)),
      };
    },
  );
  app.get('/v1/alerts/status', { onRequest: options.auth }, async () => ({
    enabled: options.alertsEnabled,
    channels: options.alertChannels ?? [],
    ...(await options.store.alertStats()),
  }));
  app.get('/v1/issues', { onRequest: options.auth }, async (request) => {
    let query;
    try {
      query = parseIssueListQuery(request.query);
    } catch {
      throw new ApiError(400, 'INVALID_LIST_QUERY');
    }
    return {
      apiVersion: 1,
      ...(await options.store.listIssues({
        ...query,
        ...(await accessOptions(request)),
      })),
    };
  });
  app.get<{ Params: { id: string } }>(
    '/v1/issues/:id',
    { onRequest: options.auth },
    async (request) => {
      if (!issueIdSchema.safeParse(request.params.id).success)
        throw new ApiError(400, 'INVALID_ISSUE_ID');
      let query;
      try {
        query = parseIssueOccurrenceQuery(request.query, request.params.id);
      } catch {
        throw new ApiError(400, 'INVALID_LIST_QUERY');
      }
      const detail = await options.store.getIssue(request.params.id, query);
      if (!detail) throw new ApiError(404, 'ISSUE_NOT_FOUND');
      return { apiVersion: 1, ...detail };
    },
  );
  app.get('/v1/incidents', { onRequest: options.auth }, async (request) => {
    let query;
    try {
      query = parseIncidentListQuery(request.query);
    } catch {
      throw new ApiError(400, 'INVALID_LIST_QUERY');
    }
    return {
      apiVersion: 1,
      ...(await options.store.list({
        ...query,
        ...(await accessOptions(request)),
      })),
    };
  });
  app.get<{ Params: { id: string } }>(
    '/v1/incidents/:id',
    { onRequest: options.auth },
    async (request) => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          request.params.id,
        )
      ) {
        throw new ApiError(400, 'INVALID_INCIDENT_ID');
      }
      const incident = await options.store.get(request.params.id.toLowerCase());
      if (!incident) throw new ApiError(404, 'INCIDENT_NOT_FOUND');
      return { apiVersion: 1, incident };
    },
  );
}
