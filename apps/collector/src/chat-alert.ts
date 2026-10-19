import { alertEventSchema, type AlertEvent } from '@timemachine/storage';

// Render captured metadata as literal text, without links or mention syntax.
const literal = (value: string) =>
  value.replace(/([\\`*_{}[\]()<>#~|!])/g, '\\$1').replaceAll('@', '@\u200b');
function details(input: AlertEvent) {
  const event = alertEventSchema.parse(input);
  return {
    event,
    title: event.type === 'issue.reopened' ? 'Issue reopened' : 'New issue',
    fields: [
      ['Service', event.service.name],
      ['Environment', event.service.environment],
      [
        'API route',
        `${event.method ?? 'Unknown method'} ${event.route ?? 'Unknown route'}`,
      ],
      ['Error code', event.errorCode ?? 'Not supplied'],
      ['Occurred (UTC)', event.occurredAt],
    ],
  };
}

export function discordIssueAlert(input: AlertEvent, issueUrl: string) {
  const { event, title, fields } = details(input);
  return {
    username: 'TimeMachine',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title,
        url: issueUrl,
        description:
          'A captured failure needs investigation. Open this issue in TimeMachine.',
        color: event.type === 'issue.reopened' ? 0xd97706 : 0xdc2626,
        fields: fields.map(([name, value]) => ({
          name: name!,
          value: literal(value!),
          inline: name === 'Service' || name === 'Environment',
        })),
        timestamp: event.occurredAt,
        footer: { text: `Event ${event.id} · Repeated occurrences are grouped.` },
      },
    ],
  };
}

/** Adaptive Card envelope supported by Teams webhook Workflows. */
export function teamsIssueAlert(input: AlertEvent, issueUrl: string) {
  const { event, title, fields } = details(input);
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.2',
          body: [
            {
              type: 'TextBlock',
              text: `TimeMachine · ${title}`,
              size: 'Large',
              weight: 'Bolder',
              color: 'Attention',
              wrap: true,
            },
            {
              type: 'TextBlock',
              text: 'A captured failure needs investigation.',
              wrap: true,
            },
            {
              type: 'FactSet',
              facts: fields.map(([title, value]) => ({ title, value: literal(value!) })),
            },
            {
              type: 'TextBlock',
              text: `Event ${event.id} · Repeated occurrences are grouped.`,
              isSubtle: true,
              size: 'Small',
              wrap: true,
            },
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'Investigate in TimeMachine',
              url: issueUrl,
            },
          ],
        },
      },
    ],
  };
}
