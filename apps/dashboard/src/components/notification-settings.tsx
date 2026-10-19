'use client';
import { useEffect, useState } from 'react';
const choices = ['slack', 'email', 'teams', 'discord', 'webhook'];
const groups: Record<string, [string, string, boolean][]> = {
  slack: [['ALERT_SLACK_URL', 'Slack incoming webhook URL', true]],
  teams: [['ALERT_TEAMS_URL', 'Teams Workflows webhook URL', true]],
  discord: [['ALERT_DISCORD_URL', 'Discord channel webhook URL', true]],
  webhook: [
    ['ALERT_WEBHOOK_URL', 'Receiver URL', true],
    ['ALERT_WEBHOOK_SECRET', 'Signing secret (at least 32 characters)', true],
  ],
  email: [
    ['SMTP_HOST', 'SMTP host', false],
    ['SMTP_PORT', 'SMTP port', false],
    ['SMTP_SECURE', 'Immediate TLS: true for 465, false for STARTTLS', false],
    ['SMTP_USER', 'SMTP username', true],
    ['SMTP_PASSWORD', 'SMTP password', true],
    ['ALERT_EMAIL_FROM', 'Sender email', false],
    ['ALERT_EMAIL_TO', 'Recipient email', false],
  ],
};
type Settings = {
  revision: number;
  source: string;
  editable: boolean;
  persistent: boolean;
  channels: string[];
  fields: Record<string, string>;
  configured: Record<string, boolean>;
};
export function NotificationSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [selected, setSelected] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  function apply(value: Settings) {
    setSettings(value);
    setSelected(value.channels);
    setFields(value.fields);
    setDirty(false);
  }
  useEffect(() => {
    void fetch('/api/notifications', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        apply(await r.json());
      })
      .catch(() =>
        setStatus(
          'Notification settings unavailable. Check the collector and database migration.',
        ),
      );
  }, []);
  async function action(test?: string) {
    setBusy(true);
    setStatus('');
    try {
      const response = await fetch('/api/notifications', {
        method: test ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          test
            ? { channel: test }
            : { revision: settings?.revision, channels: selected, fields },
        ),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (test)
        setStatus(
          'Test accepted by the provider. Check your inbox/channel (or Teams workflow history).',
        );
      else {
        apply(result);
        setStatus(
          'Notification settings saved. Changes are active; no restart required.',
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  if (!settings) return <p role="status">{status || 'Loading notification settings…'}</p>;
  return (
    <div className="notification-settings">
      <p>
        Notify your team when an issue is new or reopened. Repeated failures in an open
        issue stay grouped.
      </p>
      <p>
        Settings source: {settings.source}.{' '}
        {settings.persistent
          ? 'Saved in collector storage.'
          : 'Memory storage: settings disappear on restart.'}
      </p>
      {!settings.editable && (
        <p role="alert">
          To enable secure saving, configure NOTIFICATION_ENCRYPTION_KEY on the collector
          (a 64-character hexadecimal key), then restart it.
        </p>
      )}
      <label>
        Dashboard URL
        <input
          value={fields.ALERT_DASHBOARD_ORIGIN ?? ''}
          onChange={(e) => {
            setFields({ ...fields, ALERT_DASHBOARD_ORIGIN: e.target.value });
            setDirty(true);
          }}
          disabled={!settings.editable || busy}
        />
      </label>
      {choices.map((channel) => (
        <section key={channel} data-enabled={selected.includes(channel)}>
          <div className="alert-channel-heading">
            <h2>
              <label>
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={selected.includes(channel)}
                  className="alert-channel-switch"
                  checked={selected.includes(channel)}
                  disabled={!settings.editable || busy}
                  onChange={(e) => {
                    setSelected(
                      e.target.checked
                        ? [...selected, channel]
                        : selected.filter((c) => c !== channel),
                    );
                    setDirty(true);
                  }}
                />{' '}
                {channel === 'email'
                  ? 'Email'
                  : channel[0]!.toUpperCase() + channel.slice(1)}
              </label>
            </h2>
            <span className="alert-channel-state">
              {selected.includes(channel) ? 'Enabled' : 'Off'}
            </span>
          </div>
          {selected.includes(channel) && (
            <>
              <p>
                {channel === 'teams'
                  ? 'Use a Teams Workflows Adaptive Card webhook with trigger authentication set to Anyone.'
                  : channel === 'discord'
                    ? 'Use a channel integration webhook.'
                    : channel === 'email'
                      ? 'Use your provider’s verified sender and SMTP credentials. Remote SMTP requires TLS.'
                      : 'Enter the destination credentials below.'}
              </p>
              {groups[channel]!.map(([key, label, secret]) => (
                <label key={key}>
                  {label}
                  <input
                    type={secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={fields[key] ?? ''}
                    placeholder={
                      settings.configured[key] ? 'Configured — leave blank to keep' : ''
                    }
                    disabled={!settings.editable || busy}
                    onChange={(e) => {
                      setFields({ ...fields, [key]: e.target.value });
                      setDirty(true);
                    }}
                  />
                </label>
              ))}
              <button
                className="button"
                disabled={busy || dirty || !settings.channels.includes(channel)}
                onClick={() => void action(channel)}
              >
                Send test to {channel}
              </button>
            </>
          )}
        </section>
      ))}
      <footer className="alert-settings-footer">
        <p>
          Blank credential fields keep existing values. Disabling a channel stops its
          deliveries; credentials remain encrypted for reconnecting. Save before testing.
          Test buttons send a real notification.
        </p>
        <button
          className="button primary"
          disabled={busy || !settings.editable}
          onClick={() => void action()}
        >
          Save alerts
        </button>
      </footer>
      <p role="status">{status}</p>
    </div>
  );
}
