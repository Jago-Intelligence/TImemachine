import { RefreshButton } from '../components/refresh-button';
import Link from 'next/link';
import { Shell, Notice } from '../components/shell';
import { requireSession } from '../lib/auth';
import { CollectorUnavailable, listIssues, type IssuePage } from '../lib/collector';
export const dynamic = 'force-dynamic';
function shortTime(value: string, withDate: boolean) {
  const date = new Date(value);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(date);
  if (!withDate) return time;
  return `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date)}, ${time}`;
}
export default async function Incidents({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  if (session.WORKSPACE_AUTH_MODE === 'accounts' && !session.activeProject)
    return (
      <Shell>
        <Notice title="No projects assigned">
          Ask your workspace administrator to assign a project, or create one in Workspace
          &amp; team if you are an administrator.
        </Notice>
      </Shell>
    );
  const query = await searchParams;
  const service = session.activeProject?.service ?? query.service;
  const cursor = query.cursor;
  if (
    (service !== undefined &&
      (typeof service !== 'string' ||
        (service !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(service)))) ||
    (cursor !== undefined &&
      (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)))
  )
    return (
      <Shell>
        <Notice title="This view could not be opened">
          The service filter or page cursor is invalid. Refresh to return to the latest
          incidents.
        </Notice>
      </Shell>
    );
  let filters: { q?: string; status?: string; from?: string; to?: string };
  try {
    const text = (key: string) => {
      const value = query[key];
      if (Array.isArray(value)) throw new Error('Invalid filter');
      return value || undefined;
    };
    const q = text('q')?.trim(),
      status = text('status'),
      from = text('from'),
      to = text('to');
    if (
      q &&
      (q.length > 128 ||
        Array.from(q).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ))
    )
      throw new Error('Invalid search');
    if (status && !['open', 'resolved'].includes(status))
      throw new Error('Invalid status');
    const date = (value: string, end: boolean) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date');
      const day = new Date(value + 'T00:00:00.000Z');
      if (day.toISOString().slice(0, 10) !== value) throw new Error('Invalid date');
      if (end) day.setUTCDate(day.getUTCDate() + 1);
      return day.toISOString();
    };
    filters = {
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      ...(from ? { from: date(from, false) } : {}),
      ...(to ? { to: date(to, true) } : {}),
    };
    if (filters.from && filters.to && filters.from >= filters.to)
      throw new Error('Invalid range');
  } catch {
    return (
      <Shell>
        <Notice title="Invalid filters">
          Use a valid search, status and UTC date range.
        </Notice>
      </Shell>
    );
  }
  const base = new URLSearchParams();
  for (const key of ['service', 'q', 'status', 'from', 'to'])
    if (typeof query[key] === 'string' && query[key]) base.set(key, query[key]);
  if (session.activeProject) base.delete('service');
  const latestHref = base.size ? `/?${base}` : '/';
  let page: IssuePage;
  try {
    page = await listIssues(service || undefined, cursor, filters);
  } catch (error) {
    if (!(error instanceof CollectorUnavailable)) throw error;
    return (
      <Shell>
        <Notice
          title={
            error.status === 400
              ? 'This page link has expired'
              : 'Collector is unavailable'
          }
        >
          {error.status === 400
            ? 'Refresh the incident list to start browsing again.'
            : error.status === 429
              ? 'The collector is handling too many requests. Give it a moment, then refresh.'
              : 'Check that the collector is running and the workspace connection is configured, then refresh.'}
        </Notice>
      </Shell>
    );
  }
  const next = new URLSearchParams(base);
  if (service && !session.activeProject) next.set('service', service);
  if (page.nextCursor) next.set('cursor', page.nextCursor);
  return (
    <Shell>
      <div className="page-heading">
        <div>
          <h1>Issues</h1>
          <p>Repeated failures, grouped. Open one to see each occurrence.</p>
        </div>
        <RefreshButton href={latestHref} />
      </div>
      <section className="incident-panel" aria-labelledby="captured-title">
        <div className="tm-issue-summary" aria-label="Issue counts on this page">
          <div>
            <span>Open on this page</span>
            <strong>
              {page.items
                .filter((item) => item.status === 'open')
                .length.toLocaleString('en-GB')}
            </strong>
          </div>
          <div>
            <span>Resolved on this page</span>
            <strong>
              {page.items
                .filter((item) => item.status === 'resolved')
                .length.toLocaleString('en-GB')}
            </strong>
          </div>
          <div>
            <span>Occurrences on this page</span>
            <strong>
              {page.items
                .reduce((total, item) => total + item.occurrences, 0)
                .toLocaleString('en-GB')}
            </strong>
          </div>
        </div>
        <div className="panel-toolbar issues-filter-toolbar">
          <h2 id="captured-title" className="sr-only">
            Grouped issues
          </h2>
          <form method="get" className="filter-form issues-filter-row">
            {!session.activeProject && (
              <>
                <label htmlFor="service" className="sr-only">
                  Filter by exact service name
                </label>
                <input
                  id="service"
                  name="service"
                  placeholder="Service name"
                  defaultValue={service ?? ''}
                  maxLength={128}
                />
              </>
            )}
            <label htmlFor="q" className="sr-only">
              Search error, route, service or issue ID
            </label>
            <input
              id="q"
              name="q"
              placeholder="Search error or route"
              defaultValue={typeof query.q === 'string' ? query.q : ''}
              maxLength={128}
            />
            <label htmlFor="status" className="sr-only">
              Issue status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={typeof query.status === 'string' ? query.status : ''}
            >
              <option value="">All statuses</option>
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
            </select>
            <label htmlFor="from" className="sr-only">
              Last seen from · UTC
            </label>
            <input
              title="Last seen from · UTC"
              aria-label="Last seen from · UTC"
              id="from"
              name="from"
              type="date"
              defaultValue={typeof query.from === 'string' ? query.from : ''}
            />
            <label htmlFor="to" className="sr-only">
              Through · UTC
            </label>
            <input
              title="Last seen through · UTC"
              aria-label="Last seen through · UTC"
              id="to"
              name="to"
              type="date"
              defaultValue={typeof query.to === 'string' ? query.to : ''}
            />
            <button className="button" type="submit">
              Filter
            </button>
            {base.size > 0 && (
              <Link href="/" className="clear-filter">
                Clear
              </Link>
            )}
          </form>
          <div className="toolbar-stats">
            <span>
              {page.items.length} issues ·{' '}
              {page.items
                .reduce((total, item) => total + item.occurrences, 0)
                .toLocaleString('en-GB')}{' '}
              occurrences on this page
            </span>
            <span>
              <span className="connected-dot" />
              Collector connected
            </span>
          </div>
        </div>
        {page.items.length ? (
          <div
            className="table-scroll"
            role="region"
            aria-label="Incident table"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>ISSUE</th>
                  <th>SERVICE</th>
                  <th>STATUS</th>
                  <th>LAST SEEN · UTC</th>
                  <th className="num">OCCURRENCES</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link
                        prefetch={false}
                        href={`/issues/${item.id}`}
                        className="incident-link"
                      >
                        <span className="failure-indicator" aria-hidden="true">
                          !
                        </span>
                        <span>
                          <strong>{item.failure.code ?? item.failure.name}</strong>
                          <small>
                            {item.http
                              ? `${item.http.method} ${item.http.route}`
                              : item.failure.name}
                          </small>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <span className="service-name">{item.service.name}</span>
                      <small className="table-subtext">
                        v{item.service.version} · {item.service.environment}
                      </small>
                    </td>
                    <td>
                      <span className={`issue-status issue-status-${item.status}`}>
                        {item.status === 'resolved' ? 'Resolved' : 'Open'}
                      </span>
                    </td>
                    <td>
                      <time dateTime={item.lastSeen}>
                        {shortTime(item.lastSeen, true)}
                      </time>
                      <small className="table-subtext">
                        First seen{' '}
                        <time dateTime={item.firstSeen}>
                          {shortTime(
                            item.firstSeen,
                            item.firstSeen.slice(0, 10) !== item.lastSeen.slice(0, 10),
                          )}
                        </time>
                      </small>
                    </td>
                    <td className="num">
                      <strong>{item.occurrences.toLocaleString('en-GB')}</strong>
                      <Link
                        prefetch={false}
                        href={`/issues/${item.id}`}
                        className="open-link"
                        aria-label={`Open issue ${item.id}`}
                      >
                        <span aria-hidden="true">›</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span aria-hidden="true">◎</span>
            <h3>
              {base.size
                ? 'No issues match these filters'
                : 'Your story starts with the first capture'}
            </h3>
            <p>
              {base.size
                ? 'Change the search, date range or status, or clear the filters.'
                : 'Send a failure through the SDK or run the collector smoke check, then refresh.'}
            </p>
          </div>
        )}
        {page.items.length > 0 && (
          <p className="mobile-scroll-hint">Scroll horizontally to see all columns →</p>
        )}
        <div className="pagination">
          <span>
            Showing {page.items.length} issues{' '}
            {cursor ? '· continuing results' : '· latest page'} · newest first
          </span>
          <span className="page-note">
            Your incidents stay on your infrastructure. Data shown is sanitized by the
            collector.
          </span>
          <div>
            {cursor && (
              <Link className="button" href={latestHref}>
                Back to latest
              </Link>
            )}
            {page.nextCursor && (
              <Link className="button" href={`/?${next}`}>
                Older issues <span aria-hidden="true">→</span>
              </Link>
            )}
          </div>
        </div>
      </section>
    </Shell>
  );
}
