import { publicAlertFetch } from './alert-transport.js';
import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { parseServerConfig, type ServerConfig } from '@timemachine/config';
import type { AlertChannel, IncidentStore } from '@timemachine/storage';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAlertWorker } from './alerts.js';
import { ApiError } from './errors.js';
import { sendIssueEmail } from './email-alert.js';
import { slackIssueAlert } from './slack-alert.js';
import { teamsIssueAlert, discordIssueAlert } from './chat-alert.js';

function inputBody(request: import('fastify').FastifyRequest): unknown {
  try {
    return typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
  } catch {
    return undefined;
  }
}
const channels = ['slack', 'email', 'teams', 'discord', 'webhook'] as const;
const keys = [
  'ALERT_SLACK_URL',
  'ALERT_TEAMS_URL',
  'ALERT_DISCORD_URL',
  'ALERT_WEBHOOK_URL',
  'ALERT_WEBHOOK_SECRET',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'ALERT_EMAIL_FROM',
  'ALERT_EMAIL_TO',
  'ALERT_DASHBOARD_ORIGIN',
] as const;
const secretKeys = new Set([
  'ALERT_SLACK_URL',
  'ALERT_TEAMS_URL',
  'ALERT_DISCORD_URL',
  'ALERT_WEBHOOK_URL',
  'ALERT_WEBHOOK_SECRET',
  'SMTP_USER',
  'SMTP_PASSWORD',
]);
const inputSchema = z.strictObject({
  revision: z.number().int().min(0),
  channels: z
    .array(z.enum(channels))
    .max(5)
    .refine((items) => new Set(items).size === items.length),
  fields: z.partialRecord(z.enum(keys), z.string().max(4096)),
});
type Saved = { channels: AlertChannel[]; fields: Record<string, string> };
export async function createNotificationSettings(
  base: ServerConfig,
  store: IncidentStore,
  logger: FastifyBaseLogger,
) {
  if (
    !base.ALERT_CHANNELS &&
    base.ALERT_WEBHOOK_URL &&
    ['slack', 'teams', 'discord'].includes(base.ALERT_CHANNEL)
  ) {
    base = {
      ...base,
      [base.ALERT_CHANNEL === 'slack'
        ? 'ALERT_SLACK_URL'
        : base.ALERT_CHANNEL === 'teams'
          ? 'ALERT_TEAMS_URL'
          : 'ALERT_DISCORD_URL']: base.ALERT_WEBHOOK_URL,
    };
  }
  let active = base,
    revision = 0,
    saved: Saved | undefined;
  let worker = createAlertWorker(active, store, logger);
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let stopped = false;
  const key = base.NOTIFICATION_ENCRYPTION_KEY
    ? Buffer.from(base.NOTIFICATION_ENCRYPTION_KEY, 'hex')
    : undefined;
  function encode(value: Saved) {
    if (!key) throw new ApiError(503, 'INVALID_REQUEST');
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('timemachine.notifications.v1'));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  function decode(text: string): Saved {
    if (!key) throw new Error('Notification encryption key is required');
    const bytes = Buffer.from(text, 'base64'),
      decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from('timemachine.notifications.v1'));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        'utf8',
      ),
    ) as Saved;
  }
  function config(value: Saved) {
    const env = Object.fromEntries(
      Object.entries(base)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
    );
    Object.assign(env, value.fields);
    delete env.ALERT_CHANNELS;
    if (value.channels.length) env.ALERT_CHANNELS = value.channels.join(',');
    else {
      env.ALERT_CHANNEL = 'webhook';
      delete env.ALERT_WEBHOOK_URL;
    }
    try {
      return parseServerConfig(env);
    } catch (error) {
      const fields =
        error instanceof Error &&
        error.message.startsWith('Invalid server configuration: ')
          ? error.message
              .slice('Invalid server configuration: '.length)
              .split(', ')
              .filter((field) => /^[A-Z_]+$/.test(field))
          : [];
      throw new ApiError(400, 'INVALID_REQUEST', fields);
    }
  }
  let refreshQueue: Promise<void> = Promise.resolve();
  function refresh() {
    const pending = refreshQueue.catch(() => {}).then(refreshNow);
    refreshQueue = pending;
    return pending;
  }
  async function refreshNow() {
    const record = await store.getNotificationSettings();
    if (record && record.revision !== revision) {
      const value = decode(record.ciphertext),
        next = config(value);
      await worker.stop();
      active = next;
      saved = value;
      revision = record.revision;
      worker = createAlertWorker(active, store, logger);
      if (timer && !stopped) worker.start();
    }
  }
  await refresh();
  function view() {
    const selected = worker.channels;
    return {
      revision,
      source: saved ? 'dashboard' : 'environment',
      editable: Boolean(key),
      channels: selected,
      fields: Object.fromEntries(
        keys.filter((k) => !secretKeys.has(k)).map((k) => [k, String(active[k] ?? '')]),
      ),
      configured: Object.fromEntries(
        keys.filter((k) => secretKeys.has(k)).map((k) => [k, Boolean(active[k])]),
      ),
      persistent: base.STORAGE_DRIVER === 'postgres',
    };
  }
  return {
    get channels() {
      return worker.channels;
    },
    get enabled() {
      return worker.enabled;
    },
    start() {
      worker.start();
      timer = setInterval(() => {
        if (busy || stopped) return;
        busy = true;
        void refresh()
          .catch(() =>
            logger.warn(
              { operation: 'notifications.refresh' },
              'Notification settings unavailable',
            ),
          )
          .finally(() => {
            busy = false;
          });
      }, 5000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await refreshQueue.catch(() => {});
      await worker.stop();
    },
    install(
      app: FastifyInstance,
      auth: (
        request: import('fastify').FastifyRequest,
        reply: import('fastify').FastifyReply,
      ) => Promise<void>,
    ) {
      app.get('/v1/notifications', { preHandler: auth }, async () => {
        await refresh();
        return view();
      });
      app.put(
        '/v1/notifications',
        { preHandler: auth, bodyLimit: 16384 },
        async (request) => {
          if (!key) throw new ApiError(503, 'INVALID_REQUEST');
          const input = inputSchema.safeParse(inputBody(request));
          if (!input.success) throw new ApiError(400, 'INVALID_REQUEST');
          await refresh();
          if (input.data.revision !== revision)
            throw new ApiError(409, 'INVALID_REQUEST');
          const fields: Record<string, string> = saved
            ? { ...saved.fields }
            : Object.fromEntries(
                keys
                  .filter((k) => active[k] !== undefined)
                  .map((k) => [k, String(active[k])]),
              );
          // Blank secret inputs keep the existing value; secrets never round-trip to the browser.
          for (const [name, value] of Object.entries(input.data.fields))
            if (value?.trim()) fields[name] = value;
          const next = { channels: input.data.channels, fields };
          config(next);
          if (!(await store.saveNotificationSettings(encode(next), revision)))
            throw new ApiError(409, 'INVALID_REQUEST');
          await refresh();
          return view();
        },
      );
      app.post(
        '/v1/notifications/test',
        { preHandler: auth, bodyLimit: 1024 },
        async (request) => {
          const result = z
            .strictObject({ channel: z.enum(channels) })
            .safeParse(inputBody(request));
          if (!result.success) throw new ApiError(400, 'INVALID_REQUEST');
          await refresh();
          const channel = result.data.channel;
          if (!worker.channels.includes(channel))
            throw new ApiError(400, 'INVALID_REQUEST');
          const event = {
            version: 1 as const,
            id: randomUUID(),
            revision: 1,
            type: 'issue.created' as const,
            issueId: '0'.repeat(64),
            incidentId: randomUUID(),
            occurredAt: new Date().toISOString(),
            service: { name: 'timemachine-test', environment: 'notification-test' },
            errorCode: 'TEST_NOTIFICATION',
            method: 'TEST',
            route: '/notification-test',
          };
          const url = active.ALERT_DASHBOARD_ORIGIN + '/';
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            if (channel === 'email') {
              if (!(await sendIssueEmail(active, event, url, controller.signal)))
                throw new Error('Rejected');
            } else {
              const destination = new URL(
                !active.ALERT_CHANNELS || channel === 'webhook'
                  ? active.ALERT_WEBHOOK_URL!
                  : channel === 'slack'
                    ? active.ALERT_SLACK_URL!
                    : channel === 'teams'
                      ? active.ALERT_TEAMS_URL!
                      : active.ALERT_DISCORD_URL!,
              );
              if (channel === 'discord') destination.searchParams.set('wait', 'true');
              const payload =
                channel === 'slack'
                  ? slackIssueAlert(event, url)
                  : channel === 'teams'
                    ? teamsIssueAlert(event, url)
                    : channel === 'discord'
                      ? discordIssueAlert(event, url)
                      : { ...event, issueUrl: url, test: true };
              const body = JSON.stringify(payload);
              const timestamp = String(Math.floor(Date.now() / 1000));
              const headers: Record<string, string> = {
                'content-type': 'application/json',
                'x-timemachine-event-id': event.id,
                'x-timemachine-timestamp': timestamp,
              };
              if (channel === 'webhook' && active.ALERT_WEBHOOK_SECRET)
                headers['x-timemachine-signature'] =
                  `sha256=${createHmac('sha256', active.ALERT_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
              const transport =
                active.NODE_ENV === 'production' ? publicAlertFetch : fetch;
              const response = await transport(destination, {
                method: 'POST',
                headers,
                body,
                redirect: 'error',
                signal: controller.signal,
              });
              await response.body?.cancel();
              if (!response.ok) throw new Error('Rejected');
            }
            return { accepted: true };
          } catch {
            throw new ApiError(502, 'INVALID_REQUEST');
          } finally {
            clearTimeout(timeout);
          }
        },
      );
    },
  };
}
