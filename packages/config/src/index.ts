import { z } from 'zod';

const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

const serverEnvironment = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4318),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TIMEMACHINE_AUTH_TOKEN: z
      .string()
      .regex(/^\S{32,}$/)
      .max(256)
      .optional(),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(60),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
    INCIDENT_STORE_MAX_ENTRIES: z.coerce.number().int().min(1).max(10000).default(1000),
    INCIDENT_STORE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(262144)
      .max(268435456)
      .default(16777216),
    INCIDENT_RETENTION_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(86400000)
      .default(3600000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(10000),
    ALERT_CHANNEL: z
      .enum(['webhook', 'slack', 'email', 'teams', 'discord'])
      .default('webhook'),
    WORKSPACE_AUTH_MODE: z.enum(['legacy', 'accounts']).default('legacy'),
    WORKSPACE_ADMIN_EMAIL: z.email().max(254).optional(),
    WORKSPACE_ADMIN_PASSWORD: z.string().min(12).max(256).optional(),
    NOTIFICATION_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    ALERT_CHANNELS: z
      .string()
      .transform((value) => value.split(',').map((item) => item.trim()))
      .pipe(
        z
          .array(z.enum(['webhook', 'slack', 'email', 'teams', 'discord']))
          .min(1)
          .max(5)
          .refine((items) => new Set(items).size === items.length),
      )
      .optional(),
    ALERT_SLACK_URL: z.url().max(2048).optional(),
    ALERT_TEAMS_URL: z.url().max(2048).optional(),
    ALERT_DISCORD_URL: z.url().max(2048).optional(),
    SMTP_HOST: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9.:-]+$/)
      .optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: z.string().min(1).max(320).optional(),
    SMTP_PASSWORD: z.string().min(1).max(4096).optional(),
    ALERT_EMAIL_FROM: z.email().max(320).optional(),
    ALERT_EMAIL_TO: z.email().max(320).optional(),
    ALERT_WEBHOOK_URL: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.hash &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
        );
      })
      .optional(),
    ALERT_WEBHOOK_SECRET: z.string().min(32).max(256).optional(),
    ALERT_DASHBOARD_ORIGIN: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.origin === value &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
        );
      })
      .default('http://127.0.0.1:4321'),
    REPLAY_APPS_FILE: z.string().min(1).max(4096).optional(),
    REPLAY_IMAGE_ID: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    REPLAY_IMAGE_IDS: z
      .string()
      .max(1000)
      .refine(
        (value) =>
          value.split(',').length <= 10 &&
          value.split(',').every((id) => /^sha256:[a-f0-9]{64}$/.test(id)),
      )
      .optional(),
    STORAGE_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
    DATABASE_SSL: z.enum(['require', 'disable']).default('require'),
    DATABASE_CA_FILE: z.string().min(1).optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
    DATABASE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    DATABASE_URL: z
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'postgres:' || protocol === 'postgresql:';
      })
      .optional(),
  })
  .superRefine((env, context) => {
    if (
      env.WORKSPACE_AUTH_MODE === 'accounts' &&
      (!env.WORKSPACE_ADMIN_EMAIL || !env.WORKSPACE_ADMIN_PASSWORD)
    )
      context.addIssue({
        code: 'custom',
        path: ['WORKSPACE_ADMIN_EMAIL'],
        message: 'Account mode requires initial administrator settings',
      });
    if ((env.ALERT_CHANNELS ?? [env.ALERT_CHANNEL]).includes('email')) {
      for (const field of ['SMTP_HOST', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO'] as const)
        if (!env[field])
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Email requires SMTP configuration',
          });
      if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD))
        context.addIssue({
          code: 'custom',
          path: ['SMTP_USER'],
          message: 'SMTP credentials must be supplied together',
        });
      if (
        env.NODE_ENV === 'production' &&
        new URL(env.ALERT_DASHBOARD_ORIGIN).protocol !== 'https:'
      )
        context.addIssue({
          code: 'custom',
          path: ['ALERT_DASHBOARD_ORIGIN'],
          message: 'Production requires HTTPS dashboard',
        });
    }
    if (env.ALERT_CHANNELS) {
      for (const channel of env.ALERT_CHANNELS) {
        if (channel === 'email') continue;
        const value =
          channel === 'webhook'
            ? env.ALERT_WEBHOOK_URL
            : channel === 'slack'
              ? env.ALERT_SLACK_URL
              : channel === 'teams'
                ? env.ALERT_TEAMS_URL
                : env.ALERT_DISCORD_URL;
        const field =
          channel === 'webhook'
            ? 'ALERT_WEBHOOK_URL'
            : `ALERT_${channel.toUpperCase()}_URL`;
        if (!value) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Selected channel requires a URL',
          });
          continue;
        }
        const url = new URL(value);
        if (
          url.username ||
          url.password ||
          url.hash ||
          (url.protocol !== 'https:' &&
            !(
              env.NODE_ENV !== 'production' &&
              url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            ))
        )
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Invalid alert URL',
          });
        if (
          env.NODE_ENV !== 'test' &&
          channel === 'slack' &&
          !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
        )
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Invalid Slack URL',
          });
        if (
          env.NODE_ENV !== 'test' &&
          channel === 'discord' &&
          (url.hostname !== 'discord.com' ||
            !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+$/.test(url.pathname))
        )
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Invalid Discord URL',
          });
      }
      if (
        env.NODE_ENV === 'production' &&
        new URL(env.ALERT_DASHBOARD_ORIGIN).protocol !== 'https:'
      )
        context.addIssue({
          code: 'custom',
          path: ['ALERT_DASHBOARD_ORIGIN'],
          message: 'HTTPS required',
        });
    }
    if (
      !env.ALERT_CHANNELS &&
      env.ALERT_CHANNEL !== 'email' &&
      env.ALERT_WEBHOOK_URL &&
      env.NODE_ENV === 'production' &&
      (new URL(env.ALERT_WEBHOOK_URL).protocol !== 'https:' ||
        new URL(env.ALERT_DASHBOARD_ORIGIN).protocol !== 'https:')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ALERT_WEBHOOK_URL'],
        message: 'Production alerts require HTTPS destinations and dashboard origin',
      });
    }
    if (
      env.ALERT_WEBHOOK_URL &&
      !env.ALERT_CHANNELS &&
      env.ALERT_CHANNEL === 'slack' &&
      env.NODE_ENV !== 'test' &&
      !['hooks.slack.com', 'hooks.slack-gov.com'].includes(
        new URL(env.ALERT_WEBHOOK_URL).hostname,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ALERT_WEBHOOK_URL'],
        message: 'Slack requires an incoming webhook destination',
      });
    }
    if (
      !env.ALERT_CHANNELS &&
      env.ALERT_CHANNEL === 'discord' &&
      env.ALERT_WEBHOOK_URL &&
      env.NODE_ENV !== 'test'
    ) {
      const url = new URL(env.ALERT_WEBHOOK_URL);
      if (
        url.hostname !== 'discord.com' ||
        !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+$/.test(url.pathname)
      )
        context.addIssue({
          code: 'custom',
          path: ['ALERT_WEBHOOK_URL'],
          message: 'Discord requires an incoming webhook URL',
        });
    }
    if (
      (env.REPLAY_IMAGE_ID || env.REPLAY_APPS_FILE) &&
      (env.NODE_ENV === 'production' || env.HOST !== '127.0.0.1')
    ) {
      context.addIssue({
        code: 'custom',
        path: [env.REPLAY_APPS_FILE ? 'REPLAY_APPS_FILE' : 'REPLAY_IMAGE_ID'],
        message: 'This replay executor is local development only',
      });
    }
    if (env.STORAGE_DRIVER === 'postgres' && !env.DATABASE_URL) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'PostgreSQL requires a database URL',
      });
    }
    if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER !== 'postgres') {
      context.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message: 'Production requires durable storage',
      });
    }
    if (!loopbackHosts.has(env.HOST) && !env.TIMEMACHINE_AUTH_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['TIMEMACHINE_AUTH_TOKEN'],
        message: 'Authentication is required for non-loopback bindings',
      });
    }
  });

export type ServerConfig = Readonly<z.infer<typeof serverEnvironment>>;

/** Parse explicit input so callers control environment loading and tests stay isolated. */
export function parseServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const result = serverEnvironment.safeParse(env);
  if (!result.success) {
    // Report field names only: validation details can contain credentials or URLs.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid server configuration: ${fields.join(', ')}`);
  }
  return Object.freeze(result.data);
}
