import nodemailer from 'nodemailer';
import { connect as connectNet, isIP, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { ServerConfig } from '@timemachine/config';
import { type AlertEvent } from '@timemachine/storage';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function emailIssueAlert(event: AlertEvent, issueUrl: string) {
  const title = event.type === 'issue.reopened' ? 'Issue reopened' : 'New issue';
  const fields = [
    ['Service', event.service.name],
    ['Environment', event.service.environment],
    ['API', `${event.method ?? 'Unknown'} ${event.route ?? 'Unknown'}`],
    ['Error', event.errorCode ?? 'Unknown'],
    ['Occurred (UTC)', event.occurredAt],
    ['Event ID', event.id],
  ];
  return {
    subject: `TimeMachine: ${title} — ${event.service.name}`.replace(/[\r\n]/g, ' '),
    text: `${title}\n\n${fields.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nInvestigate in TimeMachine: ${issueUrl}\n\nRepeated occurrences in an open issue are grouped without another alert.`,
    html: `<html><body style="font-family:Arial,sans-serif;background:#f5f8f6;color:#183b2d;padding:24px"><main style="max-width:600px;margin:auto;background:white;border:1px solid #dce6df;border-radius:12px;padding:28px"><p style="color:#537260">TIMEMACHINE · ISSUE ALERT</p><h1>${title}</h1><p>A captured failure needs investigation.</p><table style="width:100%;border-collapse:collapse">${fields.map(([label, value]) => `<tr><th align="left" style="padding:12px;border-bottom:1px solid #eee">${label}</th><td style="padding:12px;border-bottom:1px solid #eee;overflow-wrap:anywhere">${escapeHtml(value!)}</td></tr>`).join('')}</table><p style="margin:28px 0"><a href="${escapeHtml(issueUrl)}" style="background:#216b50;color:white;padding:12px 18px;border-radius:6px;text-decoration:none">Investigate in TimeMachine</a></p><small>Repeated occurrences in an open issue are grouped without another alert.</small></main></body></html>`,
    messageId: `<${event.id}@timemachine>`,
  };
}

/** Own the socket so the worker deadline and shutdown cancel SMTP delivery too. */
export async function sendIssueEmail(
  config: ServerConfig,
  event: AlertEvent,
  issueUrl: string,
  signal: AbortSignal,
) {
  let socket: Socket | undefined;
  const abort = () => socket?.destroy(new Error('SMTP delivery cancelled'));
  const secure = config.SMTP_SECURE === 'true';
  const local = ['localhost', '127.0.0.1', '::1'].includes(config.SMTP_HOST!);
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure,
    requireTLS: !local || config.NODE_ENV === 'production',
    auth: config.SMTP_USER
      ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD! }
      : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
    disableFileAccess: true,
    disableUrlAccess: true,
    getSocket(_options, callback) {
      if (signal.aborted) {
        callback(new Error('SMTP delivery cancelled'), {});
        return;
      }
      socket = secure
        ? connectTls({
            host: config.SMTP_HOST!,
            port: config.SMTP_PORT,
            servername: isIP(config.SMTP_HOST!) ? undefined : config.SMTP_HOST,
            rejectUnauthorized: true,
          })
        : connectNet({ host: config.SMTP_HOST!, port: config.SMTP_PORT });
      let called = false;
      const finish = (error: Error | null) => {
        if (called) return;
        called = true;
        callback(error, error ? {} : { connection: socket, secured: secure });
      };
      socket.once(secure ? 'secureConnect' : 'connect', () => finish(null));
      socket.on('error', (error) => finish(error));
      signal.addEventListener('abort', abort, { once: true });
    },
  });
  try {
    const info = await transport.sendMail({
      from: config.ALERT_EMAIL_FROM!,
      to: config.ALERT_EMAIL_TO!,
      ...emailIssueAlert(event, issueUrl),
    });
    return info.accepted.length === 1 && info.rejected.length === 0;
  } finally {
    signal.removeEventListener('abort', abort);
    transport.close();
    socket?.destroy();
  }
}
