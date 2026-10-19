import { publicAlertFetch } from './alert-transport.js';
import { teamsIssueAlert, discordIssueAlert } from './chat-alert.js';
import { sendIssueEmail } from './email-alert.js';
import { slackIssueAlert } from './slack-alert.js';
import { createHmac } from 'node:crypto';
import type { ServerConfig } from '@timemachine/config';
import {
  ALERT_MAX_ATTEMPTS,
  type AlertDelivery,
  type AlertChannel,
  type IncidentStore,
} from '@timemachine/storage';
import type { FastifyBaseLogger } from 'fastify';

/** One destination per channel; never take delivery URLs from captured data. */
export function createAlertWorker(
  config: ServerConfig,
  store: IncidentStore,
  logger: FastifyBaseLogger,
  transport: typeof fetch = config.NODE_ENV === 'production'
    ? publicAlertFetch
    : globalThis.fetch,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const channels: readonly AlertChannel[] =
    config.ALERT_CHANNELS ??
    (config.ALERT_CHANNEL === 'email'
      ? config.SMTP_HOST
        ? ['email']
        : []
      : config.ALERT_WEBHOOK_URL
        ? [config.ALERT_CHANNEL]
        : []);
  const enabled = channels.length > 0;
  function channelConfig(channel: AlertChannel): ServerConfig {
    const url =
      !config.ALERT_CHANNELS || channel === 'webhook'
        ? config.ALERT_WEBHOOK_URL
        : channel === 'slack'
          ? config.ALERT_SLACK_URL
          : channel === 'teams'
            ? config.ALERT_TEAMS_URL
            : config.ALERT_DISCORD_URL;
    return { ...config, ALERT_CHANNEL: channel, ALERT_WEBHOOK_URL: url };
  }
  function payload(delivery: AlertDelivery, config: ServerConfig) {
    const event = delivery.event;
    const issueUrl = new URL(`/issues/${event.issueId}`, config.ALERT_DASHBOARD_ORIGIN)
      .href;
    if (config.ALERT_CHANNEL === 'slack') return slackIssueAlert(event, issueUrl);
    if (config.ALERT_CHANNEL === 'teams') return teamsIssueAlert(event, issueUrl);
    if (config.ALERT_CHANNEL === 'discord') return discordIssueAlert(event, issueUrl);
    return { ...event, issueUrl };
  }
  async function send(delivery: AlertDelivery) {
    const config = channelConfig(delivery.channel ?? channels[0]!);
    const body = JSON.stringify(payload(delivery, config));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-timemachine-event-id': delivery.event.id,
      'x-timemachine-timestamp': timestamp,
    };
    if (config.ALERT_CHANNEL === 'webhook' && config.ALERT_WEBHOOK_SECRET)
      headers['x-timemachine-signature'] =
        `sha256=${createHmac('sha256', config.ALERT_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 5000);
    timeout.unref();
    let delivered = false;
    try {
      if (config.ALERT_CHANNEL === 'email') {
        delivered = await sendIssueEmail(
          config,
          delivery.event,
          new URL(`/issues/${delivery.event.issueId}`, config.ALERT_DASHBOARD_ORIGIN)
            .href,
          controller.signal,
        );
      } else {
        const destination = new URL(config.ALERT_WEBHOOK_URL!);
        // Wait for Discord to confirm message creation rather than an unchecked 204.
        if (config.ALERT_CHANNEL === 'discord')
          destination.searchParams.set('wait', 'true');
        const response = await transport(destination.href, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: controller.signal,
        });
        delivered = response.ok;
        await response.body?.cancel();
      }
    } catch {
      /* Only safe status metadata is logged below. */
    } finally {
      clearTimeout(timeout);
      controller = undefined;
    }
    const delays = [1000, 5000, 30000, 120000, 120000];
    await store.finishAlert(
      delivery.deliveryId ?? delivery.event.id,
      delivery.lease,
      delivered,
      Date.now() + delays[delivery.attempt - 1]!,
    );
    logger[delivered ? 'info' : 'warn'](
      {
        operation: 'alert.delivery',
        channel: config.ALERT_CHANNEL,
        eventId: delivery.event.id,
        attempt: delivery.attempt,
        result: delivered
          ? 'delivered'
          : delivery.attempt >= ALERT_MAX_ATTEMPTS
            ? 'failed'
            : 'retry',
      },
      'Issue alert delivery completed',
    );
  }
  async function tick() {
    if (!enabled || stopped) return;
    try {
      const rows = await store.claimAlerts(1, 15000, channels);
      for (const row of rows) if (!stopped) await send(row);
    } catch {
      logger.warn({ operation: 'alert.worker' }, 'Alert queue unavailable; retrying');
    }
  }
  function schedule() {
    if (!enabled || stopped) return;
    running = tick().finally(() => {
      running = undefined;
      if (!stopped) {
        timer = setTimeout(schedule, 1000);
        timer.unref();
      }
    });
  }
  return {
    enabled,
    channels,
    start() {
      if (!running && !timer && !stopped) schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      await running;
    },
  };
}
