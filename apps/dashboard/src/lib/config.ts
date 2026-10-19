import { z } from 'zod';
const settings = z.object({
  WORKSPACE_AUTH_MODE: z.enum(['legacy', 'accounts']).default('legacy'),
  WORKSPACE_ADMIN_EMAIL: z.string().optional(),
  DASHBOARD_PASSWORD: z.string().min(12).max(256),
  DASHBOARD_SESSION_SECRET: z.string().regex(/^\S{32,256}$/),
  DASHBOARD_ORIGIN: z.url().default('http://127.0.0.1:4321'),
  TIMEMACHINE_AUTH_TOKEN: z.string().regex(/^\S{32,256}$/),
  TIMEMACHINE_COLLECTOR_URL: z.url().optional(),
});
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function dashboardConfig(env: Record<string, string | undefined> = process.env) {
  const result = settings.safeParse(env);
  if (!result.success) throw new Error('Dashboard configuration is incomplete');
  const config = result.data;
  const collector = new URL(config.TIMEMACHINE_COLLECTOR_URL ?? 'http://127.0.0.1:4318');
  const origin = new URL(config.DASHBOARD_ORIGIN);
  for (const url of [collector, origin]) {
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !loopback.has(url.hostname))
    ) {
      throw new Error('Invalid dashboard URL configuration');
    }
  }
  return {
    ...config,
    collector: collector.origin,
    origin: origin.origin,
    secureCookie: origin.protocol === 'https:',
  };
}
