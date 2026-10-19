'use client';
import { useEffect, useState } from 'react';
import type { ReplayInfo } from '../lib/replay-types';
import type { ReplayRun, ReplayExpectation } from '@timemachine/core';
export function ReplayPanel({
  incidentId,
  initial,
  original,
}: {
  incidentId: string;
  initial: ReplayInfo | null;
  original: { statusCode: number | null; errorCode: string | null };
}) {
  const [info, setInfo] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(false);
  const isAuth =
    info?.fixture?.runner === 'express-orders-v1' &&
    info?.fixture?.profile === 'auth-case-normalization-v1';
  const customFixture =
    info?.fixture?.runner === 'express-app-v1' ? info.fixture : undefined;
  const [targetStatus, setTargetStatus] = useState(
    initial?.fixture?.profile === 'auth-case-normalization-v1' ? '200' : '503',
  );
  const [targetCode, setTargetCode] = useState(
    initial?.fixture?.profile === 'auth-case-normalization-v1'
      ? ''
      : (original.errorCode ?? ''),
  );
  const [requireRetry, setRequireRetry] = useState(
    initial?.fixture?.profile !== 'auth-case-normalization-v1',
  );
  const latest = info?.runs[0];
  const capturedRun = info?.runs.find((record) => record.mode === 'captured');
  const currentRun = info?.runs.find((record) => record.mode === 'current');
  async function refresh() {
    const response = await fetch(`/api/incidents/${incidentId}/replays`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(
        'Could not load replay history. Check the collector and sign-in session.',
      );
    setInfo((await response.json()) as ReplayInfo);
  }
  useEffect(() => {
    if (info?.reason !== 'image-restoring') return;
    const controller = new AbortController();
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch(`/api/incidents/${incidentId}/replays`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Recovery status unavailable.');
        if (!cancelled) setInfo((await response.json()) as ReplayInfo);
      } catch {
        if (!cancelled)
          setError(
            'Could not refresh recovery status. Use Refresh history to try again.',
          );
      }
    }
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [info?.reason, incidentId]);
  async function run(target?: ReplayExpectation) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/incidents/${incidentId}/replays`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: target || current ? 'current' : 'captured',
          ...(target ? { target } : {}),
        }),
        signal: AbortSignal.timeout(25000),
      });
      const body = (await response.json()) as { run?: ReplayRun; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Replay failed');
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Replay could not be completed. Refresh history.',
      );
    } finally {
      setBusy(false);
    }
  }
  const message = !info
    ? 'Replay information could not be loaded.'
    : info.reason === 'image-restoring'
      ? 'Restoring the captured build from its private registry backup. Refresh history in a moment; replay becomes available after the exact image identity is verified.'
      : info.reason === 'image-recovery-failed'
        ? 'Recovery failed. Check registry access and Docker login on the replay host. TimeMachine will retry after one minute when you refresh history. The capture remains intact.'
        : info.reason === 'image-missing'
          ? 'The captured build is registered, but its Docker image is missing from the replay host. Restore that exact image from your backup or container registry. Rebuilding does not recreate the original build.'
          : info.reason === 'docker-unavailable'
            ? 'The replay host cannot reach Docker. Start Docker and refresh history; the saved capture and registration remain intact.'
            : info.reason === 'recording-incomplete'
              ? 'This recording omits required inputs or dependency responses. Review the recording policy and capture a new failure.'
              : info.reason === 'recording-route-unsupported'
                ? 'Automatic replay currently requires a literal route without path parameters and a fetch-compatible request body.'
                : info.reason === 'app-unregistered'
                  ? 'Register this application replay image and deploy its registry to the collector replay host. The collector automatically reloads valid registry updates. Refresh history afterwards.'
                  : info.reason === 'missing-fixture'
                    ? 'No matching replay contract was registered when this failure was captured. Register the route runner and capture a new failure.'
                    : info.reason === 'runner-disabled'
                      ? 'Build the replay image and restart the local demo to enable replay.'
                      : info.reason === 'artifact-unavailable'
                        ? 'This occurrence references an image missing from the collector’s trusted registry. Register that captured image and deploy the registry and image to the collector replay host, then refresh history. Rebuilding creates a new image; it does not recover the original captured build.'
                        : customFixture
                          ? customFixture.inputMode === 'synthetic-postgres'
                            ? 'Run the saved safe request against a fresh PostgreSQL database with reviewed synthetic fixtures. Production database state is not reproduced. Verification checks the response and declared database assertions.'
                            : customFixture.inputMode === 'recorded-http'
                              ? 'Replay generated from this captured request and its recorded dependency responses. The current build must pass the registered business assertion.'
                              : 'Repeat this registered application scenario with controlled test dependencies. Verification must pass its declared success assertions.'
                          : isAuth
                            ? 'Repeat the saved synthetic login scenario in an isolated test app. The updated code must create a session that identifies the test user. No production credentials are used.'
                            : 'Run this saved request in a disposable Express test app with an unavailable database fixture. Your orders database is not touched.';
  return (
    <section className="card replay-card">
      <span className="eyebrow">ISOLATED REPLAY</span>
      <h2>Run the failure again</h2>
      {info?.backup && (
        <span
          className={`recovery-state ${info.reason === 'image-recovery-failed' ? 'recovery-error' : ''}`}
          role="status"
        >
          {info.reason === 'image-restoring'
            ? 'Restoring build…'
            : info.reason === 'image-recovery-failed'
              ? 'Recovery failed'
              : info.backup === 'backed-up'
                ? info.available
                  ? 'Ready · backed up'
                  : 'Backed up'
                : 'No registry backup'}
        </span>
      )}
      <p>{message}</p>
      {info?.fixture && (
        <p className="replay-retention-note">
          The original build is kept registered for historical replay. Keep its Docker
          image while this capture is retained. External Docker pruning can still remove
          it.
        </p>
      )}
      {info?.fixture && (
        <p className="mono">
          {info.fixture.profile}
          {info.fixture.quantity ? ` · quantity ${info.fixture.quantity}` : ''}
        </p>
      )}
      {info?.fixture && (
        <details className="replay-build-details">
          <summary>Captured build details</summary>
          <p>This immutable image identifies the build that handled this request.</p>
          <code>{info.fixture.artifactId}</code>
          <p>
            Keep or back up this image until its captured incidents expire. Registering a
            newer build preserves this registration.
          </p>
        </details>
      )}
      {info?.available && (
        <>
          <label className="replay-choice">
            <input
              type="checkbox"
              checked={current}
              disabled={busy}
              onChange={(event) => setCurrent(event.target.checked)}
            />
            Use current trusted build instead of the captured build
          </label>
          <button className="button primary" disabled={busy} onClick={() => void run()}>
            {busy ? 'Running in sandbox…' : 'Replay failure'}
          </button>
          <details className="verification-form">
            <summary>Verify changed code</summary>
            <p>
              Run the current trusted build against the same saved scenario. Choose the
              response your updated code should return.
            </p>
            {customFixture ? (
              <p>
                Expected HTTP {customFixture.target.statusCode} ·{' '}
                {customFixture.target.errorCode ?? 'no error code'}. The registered
                scenario's success assertions must pass.
              </p>
            ) : isAuth ? (
              <p>
                Expected: HTTP 200, no error code, and a usable session for the synthetic
                test user. The runner checks /auth/me after login.
              </p>
            ) : (
              <>
                <label>
                  Expected HTTP status
                  <input
                    type="number"
                    min="100"
                    max="599"
                    value={targetStatus}
                    disabled={busy}
                    onChange={(event) => setTargetStatus(event.target.value)}
                  />
                </label>
                <label>
                  Expected error code (blank for none)
                  <input
                    maxLength={128}
                    value={targetCode}
                    disabled={busy}
                    onChange={(event) => setTargetCode(event.target.value)}
                  />
                </label>
                <label className="replay-choice">
                  <input
                    type="checkbox"
                    checked={requireRetry}
                    disabled={busy}
                    onChange={(event) => setRequireRetry(event.target.checked)}
                  />
                  Require Retry-After: 5 seconds
                </label>
              </>
            )}
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                if (customFixture) {
                  void run(customFixture.target);
                  return;
                }
                if (isAuth) {
                  void run({
                    statusCode: 200,
                    errorCode: null,
                    outcome: 'authenticated-test-user',
                  });
                  return;
                }
                const statusCode = Number(targetStatus);
                if (
                  !Number.isInteger(statusCode) ||
                  statusCode < 100 ||
                  statusCode > 599 ||
                  (targetCode && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(targetCode))
                ) {
                  setError('Use an HTTP status from 100 to 599 and a stable error code.');
                  return;
                }
                void run({
                  statusCode,
                  errorCode: targetCode || null,
                  ...(requireRetry ? { retryAfterSeconds: 5 } : {}),
                });
              }}
            >
              {busy
                ? 'Verifying…'
                : customFixture
                  ? 'Verify application fix'
                  : isAuth
                    ? 'Verify successful login'
                    : 'Verify current build'}
            </button>
          </details>
        </>
      )}
      <button
        className="button replay-refresh"
        disabled={busy}
        onClick={() => {
          setError('');
          void refresh().catch(() => setError('Replay history could not be refreshed.'));
        }}
      >
        Refresh history
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {info?.issue && (
        <div className="replay-result replay-issue-state">
          <h3>
            Issue status{' '}
            <span className={`issue-status issue-status-${info.issue.status}`}>
              {info.issue.status === 'resolved' ? 'Resolved' : 'Open'}
            </span>
          </h3>
          {info.issue.resolution && (
            <p>
              Last resolution: {info.issue.resolution.resolvedAt} · verification run{' '}
              {info.issue.resolution.runId}
            </p>
          )}
          {info.issue.status === 'open' &&
            currentRun?.verification === 'matched' &&
            currentRun.target?.outcome &&
            currentRun.issueRevision === info.issue.revision && (
              <button
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    const response = await fetch(
                      `/api/issues/${info.issue!.id}/resolve`,
                      {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                          incidentId,
                          runId: currentRun.id,
                          revision: info.issue!.revision,
                        }),
                      },
                    );
                    if (!response.ok)
                      throw new Error(
                        'Resolution was rejected. Refresh and verify again if new occurrences arrived.',
                      );
                    const refreshed = await fetch(`/api/incidents/${incidentId}/replays`);
                    if (!refreshed.ok)
                      throw new Error(
                        'Issue resolved; refresh to load its latest state.',
                      );
                    setInfo(await refreshed.json());
                  } catch (error) {
                    setError(
                      error instanceof Error ? error.message : 'Could not resolve issue.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Mark issue resolved
              </button>
            )}
          <p>
            Resolution is your explicit decision. A new occurrence automatically reopens
            the issue.
          </p>
        </div>
      )}
      <div className="replay-comparison">
        <section
          className="replay-response-section"
          aria-labelledby="replay-response-heading"
        >
          <h3 id="replay-response-heading">Compare responses</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Execution</th>
                  <th>HTTP</th>
                  <th>Error code</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Original capture</td>
                  <td>{original.statusCode ?? 'Not recorded'}</td>
                  <td>{original.errorCode ?? 'None'}</td>
                </tr>
                <tr>
                  <td>Captured build replay</td>
                  <td>
                    {capturedRun?.actual?.statusCode ??
                      (capturedRun ? capturedRun.status : 'No retained run')}
                  </td>
                  <td>
                    {capturedRun?.actual ? (capturedRun.actual.errorCode ?? 'None') : '—'}
                  </td>
                </tr>
                <tr>
                  <td>Current build replay</td>
                  <td>
                    {currentRun?.actual?.statusCode ??
                      (currentRun ? currentRun.status : 'No retained run')}
                  </td>
                  <td>
                    {currentRun?.actual ? (currentRun.actual.errorCode ?? 'None') : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section
          className="replay-checks-section"
          aria-labelledby="replay-checks-heading"
        >
          <h3 id="replay-checks-heading">Verification checks</h3>
          <p>
            Response and error checks compare with the declared success target. Older runs
            may not report individual checks.
          </p>
          <div className="table-scroll">
            <table className="replay-checks-table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Captured build</th>
                  <th>Current build</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['response-status', 'Intended HTTP status'],
                    ['error-code', 'Intended error code'],
                    ['business-assertions', 'Business assertions'],
                    ['database-rollback', 'Transaction rollback'],
                    ['database-commit', 'Committed rows and relationships'],
                  ] as const
                ).map(([id, label]) => (
                  <tr key={id}>
                    <td>{label}</td>
                    <td>
                      {capturedRun?.actual?.checks?.find((check) => check.id === id)
                        ?.status ??
                        (capturedRun?.actual?.checks ? 'Not applicable' : 'Not reported')}
                    </td>
                    <td>
                      {currentRun?.actual?.checks?.find((check) => check.id === id)
                        ?.status ??
                        (currentRun?.actual?.checks ? 'Not applicable' : 'Not reported')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {currentRun && info?.fixture?.artifactId === currentRun.artifactId && (
          <p>
            The current and captured builds are the same image. Rebuild and restart the
            demo after changing application code.
          </p>
        )}
        <p>
          Matching the chosen target verifies this test scenario only. It does not
          automatically resolve the grouped issue.
        </p>
      </div>
      {latest && (
        <div className="replay-result" role="status">
          <h3>
            {latest.verification === 'matched'
              ? latest.target?.outcome === 'authenticated-test-user'
                ? 'Successful login verified'
                : latest.target?.outcome === 'scenario-assertions-passed'
                  ? 'Application scenario verified'
                  : 'Expected behavior confirmed'
              : latest.verification === 'not-matched'
                ? 'Expected behavior not met'
                : latest.status === 'reproduced'
                  ? 'Failure reproduced'
                  : latest.status === 'not-reproduced'
                    ? 'Behavior changed'
                    : latest.status === 'running'
                      ? 'Replay is running'
                      : 'Replay execution failed'}
          </h3>
          <p>
            {latest.status === 'reproduced'
              ? 'The test returned the same HTTP status and application error code.'
              : latest.status === 'not-reproduced'
                ? 'The response differs from the original capture. A changed response alone does not establish a fix.'
                : (latest.errorCode ?? 'Refresh history for the result.')}
          </p>
          <dl>
            <dt>Build</dt>
            <dd>{latest.mode}</dd>
            <dt>Original capture</dt>
            <dd>
              HTTP {latest.expected.statusCode} ·{' '}
              {latest.expected.errorCode ?? 'no error code'}
            </dd>
            {latest.target && (
              <>
                <dt>Verification target</dt>
                <dd>
                  HTTP {latest.target.statusCode} ·{' '}
                  {latest.target.errorCode ?? 'no error code'}
                  {latest.target.retryAfterSeconds !== undefined
                    ? ` · Retry-After ${latest.target.retryAfterSeconds}s`
                    : ''}
                </dd>
              </>
            )}
            {latest.verification && (
              <>
                <dt>Target check</dt>
                <dd>
                  {latest.verification === 'matched'
                    ? 'Expected behavior confirmed'
                    : 'Expected behavior not met'}
                </dd>
              </>
            )}
            {latest.actual && (
              <>
                <dt>Observed</dt>
                <dd>
                  HTTP {latest.actual.statusCode} ·{' '}
                  {latest.actual.errorCode ?? 'no error code'}
                </dd>
                {latest.actual.outcome && (
                  <>
                    <dt>Successful result</dt>
                    <dd>
                      {latest.actual.outcome === 'scenario-assertions-passed'
                        ? 'Registered application success assertions passed'
                        : 'Authenticated test user and usable session confirmed via /auth/me'}
                    </dd>
                  </>
                )}
                {latest.actual.retryAfterSeconds !== undefined && (
                  <>
                    <dt>Retry guidance</dt>
                    <dd>Retry after {latest.actual.retryAfterSeconds} seconds</dd>
                  </>
                )}
                {latest.actual.responseHint && (
                  <>
                    <dt>Customer message</dt>
                    <dd>Service temporarily unavailable. Please try again.</dd>
                  </>
                )}
                <dt>Sandbox Node</dt>
                <dd>{latest.actual.runtimeVersion}</dd>
              </>
            )}
            <dt>Run ID</dt>
            <dd className="mono">{latest.id}</dd>
          </dl>
          {latest.actual && (
            <ol className="replay-events">
              {latest.actual.timeline.map((event) => (
                <li key={event.id}>
                  <span className="mono">+{event.offsetMs} ms</span>{' '}
                  {event.type === 'http.request'
                    ? `${event.method} ${event.route}`
                    : event.type === 'http.response'
                      ? `HTTP ${event.statusCode}`
                      : event.type === 'error'
                        ? event.code
                        : `${event.operation} · ${event.outcome}`}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {(info?.runs.length ?? 0) > 1 && (
        <details className="replay-history">
          <summary>Previous runs ({info!.runs.length - 1})</summary>
          <ul>
            {info!.runs.slice(1).map((record) => (
              <li key={record.id}>
                {new Date(record.startedAt).toISOString()} · {record.mode} ·{' '}
                {record.status}
                {record.verification ? ` · target ${record.verification}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
