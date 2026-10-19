import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Shell, Notice, Status, timeLabel } from '../../../components/shell';
import { RefreshButton } from '../../../components/refresh-button';
import { requireSession } from '../../../lib/auth';
import { CollectorUnavailable, getIssue, type IssueDetail } from '../../../lib/collector';
export const dynamic = 'force-dynamic';
export default async function Issue({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) notFound();
  const query = await searchParams;
  const cursor = query.cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor))
  )
    return (
      <Shell>
        <Notice title="Invalid occurrence page">
          Return to this issue's latest occurrences.
        </Notice>
      </Shell>
    );
  let detail: IssueDetail;
  try {
    detail = await getIssue(id, cursor);
  } catch (error) {
    if (!(error instanceof CollectorUnavailable)) throw error;
    if (error.status === 404) notFound();
    return (
      <Shell>
        <Notice title="Issue could not be loaded">
          Refresh this issue. Check the collector if the problem continues.
        </Notice>
      </Shell>
    );
  }
  const { issue, occurrences } = detail;
  return (
    <Shell>
      <Link href="/" className="back-link">
        ‹ Issues
      </Link>
      <div className="page-heading">
        <div>
          <h1>{issue.failure.code ?? issue.failure.name}</h1>
          <p>
            {issue.http
              ? `${issue.http.method} ${issue.http.route}`
              : 'Application failure'}{' '}
            · {issue.service.name} · {issue.service.environment} ·{' '}
            <span className={`issue-status issue-status-${issue.status}`}>
              {issue.status === 'resolved' ? 'Resolved' : 'Open'}
            </span>
          </p>
        </div>
        <RefreshButton href={`/issues/${id}`} />
      </div>
      <div className="detail-metadata">
        <div>
          <span>OCCURRENCES</span>
          <strong>{issue.occurrences.toLocaleString('en-GB')}</strong>
        </div>
        <div>
          <span>FIRST SEEN · UTC</span>
          <strong>{timeLabel(issue.firstSeen)}</strong>
        </div>
        <div>
          <span>LAST SEEN · UTC</span>
          <strong>{timeLabel(issue.lastSeen)}</strong>
        </div>
        <div>
          <span>LATEST APPLICATION VERSION</span>
          <strong>{issue.service.version}</strong>
        </div>
      </div>
      {issue.resolution && (
        <section className="card issue-resolution-section">
          <h2>
            {issue.status === 'resolved'
              ? 'Resolved with verification'
              : 'Reopened after resolution'}
          </h2>
          <p>
            Last resolved at {issue.resolution.resolvedAt}. New occurrences reopen the
            issue without deleting the prior verification evidence.
          </p>
          <Link href={`/incidents/${issue.resolution.incidentId}?issue=${id}`}>
            View verification occurrence →
          </Link>
        </section>
      )}
      <section className="incident-panel">
        <div className="panel-toolbar">
          <div>
            <h2>Occurrences</h2>
            <span className={`issue-status issue-status-${issue.status}`}>
              {issue.status === 'resolved' ? 'Resolved' : 'Open'}
            </span>
            <p>
              Open a capture for its request details, source locations and replay history.
            </p>
          </div>
        </div>
        <div
          className="table-scroll"
          role="region"
          aria-label="Occurrence table"
          tabIndex={0}
        >
          <table className="occurrence-table">
            <thead>
              <tr>
                <th>OCCURRED · UTC</th>
                <th>INCIDENT ID</th>
                <th>APPLICATION VERSION</th>
                <th>REPLAY</th>
                <th>
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {occurrences.items.map((item) => (
                <tr
                  key={item.id}
                  className={
                    item.id === issue.latestIncidentId
                      ? 'occurrence-latest'
                      : 'occurrence-older'
                  }
                >
                  <td>
                    <time dateTime={item.occurredAt}>{timeLabel(item.occurredAt)}</time>
                    {item.id === issue.latestIncidentId && (
                      <span className="occurrence-new">Latest</span>
                    )}
                  </td>
                  <td className="mono">{item.id}</td>
                  <td>{item.service.version}</td>
                  <td>
                    <Status status={item.replayStatus} />
                  </td>
                  <td>
                    <Link
                      prefetch={false}
                      className="open-text"
                      href={`/incidents/${item.id}?issue=${id}`}
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          <span>
            Showing {occurrences.items.length} of {issue.occurrences} retained occurrences
          </span>
          <div>
            {cursor && (
              <Link className="button" href={`/issues/${id}`}>
                Back to latest
              </Link>
            )}
            {occurrences.nextCursor && (
              <Link
                className="button"
                href={`/issues/${id}?cursor=${encodeURIComponent(occurrences.nextCursor)}`}
              >
                Older occurrences →
              </Link>
            )}
          </div>
        </div>
      </section>
      <p className="page-note">
        Counts and first/last seen times cover retained captures, not unique users.
        Delivery retries do not add occurrences. Expired captures are excluded.
      </p>
    </Shell>
  );
}
