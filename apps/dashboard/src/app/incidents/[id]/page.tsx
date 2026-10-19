import { ReplayPanel } from '../../../components/replay-panel';
import type { ReplayInfo } from '../../../lib/replay-types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { explainCause, type Incident } from '@timemachine/core';
import { Shell, Status, Notice, timeLabel } from '../../../components/shell';
import { requireSession } from '../../../lib/auth';
import { CollectorUnavailable, getIncident, getReplayInfo } from '../../../lib/collector';
export const dynamic = 'force-dynamic';
export default async function Detail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const { id } = await params;
  const parent = (await searchParams).issue;
  const issueLink =
    typeof parent === 'string' && /^[a-f0-9]{64}$/.test(parent)
      ? `/issues/${parent}`
      : '/';
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  )
    notFound();
  let incident: Incident;
  try {
    incident = await getIncident(id);
  } catch (error) {
    if (!(error instanceof CollectorUnavailable)) throw error;
    if (error.status === 404) notFound();
    return (
      <Shell>
        <Notice title="Incident could not be loaded">
          The collector is unavailable. Return to the incident list and try again.
        </Notice>
      </Shell>
    );
  }
  const cause = explainCause(incident);
  let replayInfo: ReplayInfo | null = null;
  try {
    replayInfo = await getReplayInfo(id);
  } catch (error) {
    if (!(error instanceof CollectorUnavailable)) throw error;
  }
  const request = incident.timeline.find((event) => event.type === 'http.request');
  const response = incident.timeline.findLast((event) => event.type === 'http.response');
  const errorEvent = incident.timeline.find((event) => event.type === 'error');
  return (
    <Shell>
      <Link href={issueLink} className="back-link">
        {`‹ ${incident.failure.code ?? 'Issue'}`}
      </Link>
      <div className="page-heading detail-heading">
        <div>
          <h1>{incident.failure.code}</h1>
          <p className="mono">{incident.id}</p>
        </div>
        <Status status={incident.replay.status} />
      </div>
      <div className="detail-metadata">
        <div>
          <span>SERVICE</span>
          <strong>{incident.service.name}</strong>
        </div>
        <div>
          <span>ENVIRONMENT</span>
          <strong>{incident.service.environment}</strong>
        </div>
        <div>
          <span>OCCURRED · UTC</span>
          <strong>{timeLabel(incident.occurredAt)}</strong>
        </div>
        <div>
          <span>RUNTIME</span>
          <strong>
            {incident.runtime.name} {incident.runtime.version}
          </strong>
        </div>
      </div>
      <div className="detail-grid">
        <div className="detail-main">
          <section className="card cause-card">
            <span className="eyebrow">
              {cause.status === 'supported'
                ? 'FAILURE EXPLANATION'
                : cause.status === 'observed'
                  ? 'DEPENDENCY EVIDENCE'
                  : 'FAILURE INVESTIGATION'}
            </span>
            <h2>{cause.title}</h2>
            <p>{cause.explanation}</p>
            {cause.evidence.length > 0 && (
              <div className="kv-list">
                {cause.evidence.map((item) => {
                  const at = item.indexOf(': ');
                  return (
                    <div className="kv-row" key={item}>
                      <span>{at > 0 ? item.slice(0, at) : ''}</span>
                      <span>
                        {(at > 0 ? item.slice(at + 2) : item).replace(/\.$/, '')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {cause.status === 'supported' && (
              <p className="table-subtext">
                Source and recorded data matched for this pattern. This does not establish
                the underlying business cause or prove that every related request is
                fixed.
              </p>
            )}
          </section>
          <section className="card timeline-card">
            <div className="card-heading">
              <h2>
                Execution timeline{' '}
                <span className="count">{incident.timeline.length}</span>
              </h2>
              <p>Elapsed time from the start of the captured request.</p>
            </div>
            <ol className="timeline">
              {incident.timeline.map((event) => (
                <li key={event.id}>
                  <span
                    className={`event-dot ${event.type === 'error' || (event.type === 'dependency' && event.outcome === 'failure') ? 'event-failed' : ''}`}
                  />
                  <span className="elapsed">+{event.offsetMs} ms</span>
                  <div className="event-content">
                    <span className="event-type">{event.type.replace('.', ' / ')}</span>
                    <h3>
                      {event.type === 'http.request'
                        ? `${event.method} ${event.route}`
                        : event.type === 'http.response'
                          ? `Response · HTTP ${event.statusCode}`
                          : event.type === 'error'
                            ? event.code
                            : `${event.dependencyId} · ${event.operation}`}
                    </h3>
                    {event.type === 'dependency' && (
                      <p>
                        <span className={event.outcome === 'failure' ? 'error-text' : ''}>
                          {event.outcome}
                        </span>{' '}
                        · {event.durationMs} ms
                      </p>
                    )}
                    <small className="mono">{event.id}</small>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          {incident.recording && (
            <section className="card">
              <h2>Recorded inputs</h2>
              <p>
                Recording policy <code>{incident.recording.policyId}</code>. Only selected
                fields are stored. Partial recordings require reviewed fixtures before
                replay.
              </p>
              <dl>
                <dt>Request body</dt>
                <dd>
                  <code>{JSON.stringify(incident.recording.request.body)}</code>
                </dd>
                <dt>Request fields omitted</dt>
                <dd>{incident.recording.request.partial ? 'Yes' : 'No'}</dd>
                <dt>Unrecorded or unfinished calls</dt>
                <dd>{incident.recording.truncated ? 'Yes' : 'No'}</dd>
              </dl>
              {incident.recording.operations?.map((operation, index) => (
                <div className="recorded-call" key={`operation-${index}`}>
                  <div className="recorded-call-head">
                    <span className="call-kind">{operation.kind}</span>
                    <strong>
                      {operation.id} · {operation.operation}
                    </strong>
                    <span className="call-result">{operation.result}</span>
                  </div>
                  <p>
                    {operation.partial
                      ? 'Partial recording; replay unavailable'
                      : 'Selected result recorded'}
                  </p>
                  <pre>
                    {JSON.stringify(
                      { input: operation.input, rows: operation.rows },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              ))}
              {incident.recording.postgres?.map((query, index) => (
                <div className="recorded-call" key={`pg-${index}`}>
                  <div className="recorded-call-head">
                    <span className="call-kind">PostgreSQL</span>
                    <strong>{query.id}</strong>
                    <span className="call-result">
                      {query.result === 'error'
                        ? query.errorCode
                        : `${query.rowCount ?? '?'} ${query.rowCount === 1 ? 'row' : 'rows'}`}
                    </span>
                  </div>
                  <p>
                    {query.partial
                      ? 'Partial database recording'
                      : 'Selected database result recorded'}
                  </p>
                  <div className="call-field">
                    <span>Query fingerprint</span>
                    <code>{query.queryHash}</code>
                  </div>
                  <span className="call-label">Parameters and rows</span>
                  <pre>
                    {JSON.stringify(
                      { parameters: query.parameters, rows: query.rows },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              ))}
              {incident.recording.dependencies.map((dependency, index) => (
                <div className="recorded-call" key={index}>
                  <div className="recorded-call-head">
                    <span className="call-kind">HTTP</span>
                    <strong>
                      {dependency.id} · {dependency.method} {dependency.route}
                    </strong>
                    <span className="call-result">
                      {dependency.statusCode
                        ? `HTTP ${dependency.statusCode}`
                        : dependency.result}
                    </span>
                  </div>
                  <p>
                    {dependency.partial
                      ? 'Partial response'
                      : 'Selected response fields recorded'}
                  </p>
                  <span className="call-label">Response body</span>
                  <pre>{JSON.stringify(dependency.body, null, 2)}</pre>
                </div>
              ))}
            </section>
          )}
          <section className="card">
            <h2>Request details</h2>
            <dl>
              <dt>Error observed · UTC</dt>
              <dd>
                <time dateTime={incident.occurredAt}>{incident.occurredAt}</time>
              </dd>
              <dt>Response status</dt>
              <dd>
                {response
                  ? `HTTP ${response.statusCode}`
                  : 'No completed response recorded'}
              </dd>
              <dt>Error after request start</dt>
              <dd>
                {request && errorEvent ? `${errorEvent.offsetMs} ms` : 'Not recorded'}
              </dd>
              <dt>Recorded response duration</dt>
              <dd>{request && response ? `${response.offsetMs} ms` : 'Not recorded'}</dd>
              {incident.failure.frames[0] && (
                <>
                  <dt>First captured source location</dt>
                  <dd className="mono">
                    {incident.failure.frames[0].file}:{incident.failure.frames[0].line}:
                    {incident.failure.frames[0].column ?? 1}
                  </dd>
                </>
              )}
              <dt>Error code</dt>
              <dd>{incident.failure.code ?? 'Not recorded'}</dd>
              <dt>Request ID</dt>
              <dd className="mono">{incident.correlation.requestId}</dd>
            </dl>
            <p>
              Use the request ID to find related application logs. Source locations show
              where the error was thrown; they do not by themselves establish its root
              cause.
            </p>
          </section>
        </div>
        <aside className="detail-aside">
          <ReplayPanel
            incidentId={incident.id}
            initial={replayInfo}
            original={{
              statusCode: response?.statusCode ?? null,
              errorCode: incident.failure.code ?? null,
            }}
          />
          <section className="card failure-card">
            <h2>{incident.failure.name}</h2>
            <p>{incident.failure.summary}</p>
            <dl>
              <dt>Source</dt>
              <dd>{incident.failure.source}</dd>
              <dt>Request ID</dt>
              <dd className="mono">{incident.correlation.requestId}</dd>
              <dt>Correlation ID</dt>
              <dd className="mono">{incident.correlation.correlationId}</dd>
              <dt>Application version</dt>
              <dd>{incident.service.version}</dd>
              <dt>Captured · UTC</dt>
              <dd>{incident.capturedAt}</dd>
            </dl>
          </section>
          <section className="card">
            <h2>Source locations</h2>
            {incident.failure.frames.length ? (
              <ol className="frames">
                {incident.failure.frames.map((frame, index) => (
                  <li key={index}>
                    <span className="frame-number">{index + 1}</span>
                    <code>
                      {frame.file}
                      {frame.line !== undefined ? `:${frame.line}` : ''}
                      {frame.column !== undefined ? `:${frame.column}` : ''}
                    </code>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No project source locations were captured.</p>
            )}
          </section>
        </aside>
      </div>
    </Shell>
  );
}
