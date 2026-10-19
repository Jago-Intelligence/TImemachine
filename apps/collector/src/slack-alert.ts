import { alertEventSchema, type AlertEvent } from '@timemachine/storage';

const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** Build Slack blocks from approved alert metadata, never raw failure contents. */
export function slackIssueAlert(input: AlertEvent, issueUrl: string) {
  const event = alertEventSchema.parse(input);
  const reopened = event.type === 'issue.reopened';
  const label = reopened ? 'Issue reopened' : 'New issue';
  const date = new Date(event.occurredAt);
  const fallback =
    new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    }).format(date) + ' UTC';
  const field = (label: string, value: string) => ({
    type: 'mrkdwn',
    text: `*${label}*\n\`${escape(value).replaceAll('`', 'ˋ').replaceAll('\n', ' ')}\``,
    verbatim: true,
  });
  return {
    // Detailed fallback for notifications, screen readers and clients without blocks.
    text: `${label}: ${event.service.name} (${event.service.environment}) · ${event.method ?? 'Unknown method'} ${event.route ?? 'Unknown route'} · ${event.errorCode ?? 'Unknown error'} · ${fallback}`,
    mrkdwn: false,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${reopened ? '🟠' : '🔴'} ${label}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text: reopened
            ? 'A resolved issue has failed again. Investigate the new occurrence.'
            : 'A new failure was captured. Open the issue to investigate and replay it.',
          emoji: false,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          field('Service', event.service.name),
          field('Environment', event.service.environment),
        ],
      },
      {
        type: 'section',
        fields: [
          field(
            'API route',
            `${event.method ?? 'Unknown method'} ${event.route ?? 'Unknown route'}`,
          ),
          field('Error code', event.errorCode ?? 'Not supplied'),
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Occurred*\n<!date^${Math.floor(date.getTime() / 1000)}^{date_short_pretty} at {time_secs}|${fallback}>`,
            verbatim: true,
          },
          { type: 'mrkdwn', text: '*Issue status*\nOpen', verbatim: true },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: {
              type: 'plain_text',
              text: 'Investigate in TimeMachine',
              emoji: false,
            },
            url: issueUrl,
            action_id: 'open_issue',
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'plain_text',
            text: `TimeMachine · Event ${event.id.slice(0, 8)} · Repeated occurrences are grouped into this issue.`,
            emoji: false,
          },
        ],
      },
    ],
  };
}
