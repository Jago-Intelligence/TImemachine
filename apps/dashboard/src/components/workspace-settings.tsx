'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
type Project = { id: string; name: string; service: string };
type User = {
  id: string;
  email: string;
  role: 'admin' | 'developer';
  enabled: boolean;
  projects: string[];
};
type Token = {
  id: string;
  projectId: string;
  label: string;
  prefix: string;
  revoked: boolean;
  createdAt: string;
};
type Overview = { users: User[]; projects: Project[]; tokens: Token[] };
type Tab = 'Projects' | 'People' | 'Tokens' | 'Security';
type Modal =
  | { kind: 'project' | 'user' | 'password' | 'token' }
  | { kind: 'edit'; user: User }
  | { kind: 'revoke'; token: Token };

function Dialog({
  title,
  description,
  children,
  close,
  busy,
}: {
  title: string;
  description: string;
  children: ReactNode;
  close: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="ws-dialog"
      aria-labelledby="workspace-dialog-title"
      aria-describedby="workspace-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <div>
          <span className="ws-kicker">Workspace settings</span>
          <h2 id="workspace-dialog-title">{title}</h2>
        </div>
        <button
          type="button"
          className="ws-close"
          aria-label="Close dialog"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      <p id="workspace-dialog-description" className="ws-muted">
        {description}
      </p>
      {children}
    </dialog>
  );
}
export function WorkspaceSettings({
  admin,
  currentUser,
  activeProjectName,
}: {
  admin: boolean;
  currentUser: string;
  activeProjectName?: string | undefined;
}) {
  const [data, setData] = useState<Overview>({ users: [], projects: [], tokens: [] });
  const [tab, setTab] = useState<Tab>('Projects');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<Modal>();
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState('developer');
  const [issued, setIssued] = useState<string>();
  const [copied, setCopied] = useState(false);
  async function call(path: string, method = 'GET', input?: unknown) {
    const response = await fetch('/api/workspace/' + path, {
      method,
      ...(input ? { body: JSON.stringify(input) } : {}),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : 'Request failed. Please try again.',
      );
    return result;
  }
  async function refresh() {
    if (admin) setData(await call('overview'));
    else {
      const me = await call('me');
      setData({ users: [me.user], projects: me.projects, tokens: [] });
    }
  }
  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setStatus(err instanceof Error ? err.message : 'Workspace unavailable.'),
      )
      .finally(() => setLoading(false));
  }, []);
  function open(next: Modal) {
    setError('');
    setIssued(undefined);
    setCopied(false);
    setSelected(
      next.kind === 'edit'
        ? next.user.projects
        : next.kind === 'user' && data.projects[0]
          ? [data.projects[0].id]
          : [],
    );
    setRole(next.kind === 'edit' ? next.user.role : 'developer');
    setModal(next);
  }
  function close() {
    setModal(undefined);
    setError('');
    setIssued(undefined);
  }
  async function perform(action: () => Promise<void>, keepOpen = false) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action();
      if (!keepOpen) close();
      setStatus('Changes saved.');
      try {
        await refresh();
      } catch {
        setStatus('Changes saved. Reload the page to refresh the list.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  const query = search.trim().toLowerCase();
  const matches = (...values: string[]) => values.join(' ').toLowerCase().includes(query);
  const projects = data.projects.filter((p) => matches(p.name, p.service));
  const users = data.users.filter(
    (u) =>
      matches(u.email, u.role) &&
      (filter === 'all' ||
        (filter === 'disabled' ? !u.enabled : u.enabled && u.role === filter)),
  );
  const tokens = data.tokens.filter(
    (t) =>
      matches(
        t.label,
        t.prefix,
        data.projects.find((p) => p.id === t.projectId)?.name ?? '',
      ) &&
      (filter === 'all' || (filter === 'active' ? !t.revoked : t.revoked)),
  );
  function memberships() {
    return (
      <fieldset className="ws-memberships">
        <legend>Project access</legend>
        {role === 'admin' ? (
          <p className="ws-muted">
            Administrators can access every project and manage workspace settings.
          </p>
        ) : data.projects.length ? (
          data.projects.map((p) => (
            <label key={p.id} className="ws-check">
              <input
                type="checkbox"
                checked={selected.includes(p.id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, p.id]
                      : selected.filter((id) => id !== p.id),
                  )
                }
              />
              <span>
                {p.name}
                <small>{p.service}</small>
              </span>
            </label>
          ))
        ) : (
          <p className="ws-muted">Create a project first to assign access.</p>
        )}
      </fieldset>
    );
  }
  const descriptions: Record<Tab, string> = {
    Projects: 'Organize your backend services and the people who investigate them.',
    People: 'Manage individual accounts, roles, and project access.',
    Tokens: 'Connect your SDK to a project with a dedicated ingestion token.',
    Security: 'Keep your workspace account secure.',
  };
  const titles = {
    project: 'Add project',
    user: 'Add user',
    edit: 'Edit user',
    token: 'Create ingestion token',
    password: 'Change password',
    revoke: 'Revoke token',
  };
  return (
    <div className="workspace-settings">
      <div className="ws-intro">
        <span className="ws-kicker">
          {activeProjectName ? 'Project settings' : 'Manage your workspace'}
        </span>
        <p>
          {activeProjectName
            ? `Access and credentials for ${activeProjectName}. Account roles and passwords apply across the workspace.`
            : 'Create a project to connect a backend service.'}
        </p>
        <span className="ws-badge">{admin ? 'Administrator' : 'Developer'} access</span>
      </div>
      <div className="ws-summary">
        <div>
          <span>Projects</span>
          <strong>{data.projects.length}</strong>
          <small>{activeProjectName ? 'Selected project' : 'No project selected'}</small>
        </div>
        {admin && (
          <>
            <div>
              <span>Team members</span>
              <strong>{data.users.filter((u) => u.enabled).length}</strong>
              <small>Active accounts with project access</small>
            </div>
            <div>
              <span>Active tokens</span>
              <strong>{data.tokens.filter((t) => !t.revoked).length}</strong>
              <small>Project ingestion credentials</small>
            </div>
          </>
        )}
      </div>
      <nav className="ws-tabs" aria-label="Workspace sections">
        {(['Projects', ...(admin ? ['People', 'Tokens'] : []), 'Security'] as Tab[]).map(
          (item) => (
            <button
              key={item}
              type="button"
              aria-current={tab === item ? 'page' : undefined}
              onClick={() => {
                setTab(item);
                setSearch('');
                setFilter('all');
              }}
            >
              {item}
            </button>
          ),
        )}
      </nav>
      {status && (
        <p className="ws-notice" role="status">
          {status}
        </p>
      )}
      <section className="ws-panel" aria-labelledby="workspace-section-title">
        <div className="ws-panel-heading">
          <div>
            <h2 id="workspace-section-title">{tab}</h2>
            <p>{descriptions[tab]}</p>
          </div>
          {admin && tab !== 'Security' && (
            <button
              className="button primary"
              disabled={loading}
              onClick={() =>
                open({
                  kind:
                    tab === 'Projects' ? 'project' : tab === 'People' ? 'user' : 'token',
                })
              }
            >
              +{' '}
              {tab === 'Projects'
                ? 'Add project'
                : tab === 'People'
                  ? 'Add user'
                  : 'Create token'}
            </button>
          )}
        </div>
        {tab === 'Security' ? (
          <div className="ws-security">
            <div className="ws-security-icon" aria-hidden="true">
              ↗
            </div>
            <div>
              <h3>Account password</h3>
              <p>
                Use a unique password of at least 12 characters. Changing it signs you out
                of all sessions.
              </p>
            </div>
            <button className="button" onClick={() => open({ kind: 'password' })}>
              Change password
            </button>
          </div>
        ) : (
          <>
            <div className="ws-toolbar">
              <label className="ws-search">
                <span className="sr-only">Search {tab.toLowerCase()}</span>
                <input
                  type="search"
                  placeholder={`Search ${tab.toLowerCase()}…`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              {tab !== 'Projects' && (
                <label>
                  <span className="sr-only">Filter {tab.toLowerCase()}</span>
                  <select
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <option value="all">All {tab.toLowerCase()}</option>
                    {tab === 'People' ? (
                      <>
                        <option value="admin">Administrators</option>
                        <option value="developer">Developers</option>
                        <option value="disabled">Disabled accounts</option>
                      </>
                    ) : (
                      <>
                        <option value="active">Active tokens</option>
                        <option value="revoked">Revoked tokens</option>
                      </>
                    )}
                  </select>
                </label>
              )}
              <span className="ws-muted">
                {loading
                  ? 'Loading…'
                  : `${tab === 'Projects' ? projects.length : tab === 'People' ? users.length : tokens.length} results`}
              </span>
            </div>
            <div className="ws-table-wrap">
              <table className="ws-table">
                <thead>
                  <tr>
                    {(tab === 'Projects'
                      ? [
                          'Project',
                          'Service',
                          ...(admin ? ['Members', 'Active tokens'] : []),
                        ]
                      : tab === 'People'
                        ? ['Member', 'Role', 'Project access', 'Status', '']
                        : ['Token', 'Project', 'Created', 'Status', '']
                    ).map((heading, index) => (
                      <th key={index}>
                        {heading || <span className="sr-only">Actions</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tab === 'Projects' &&
                    projects.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <div className="ws-identity">
                            <span className="ws-avatar" aria-hidden="true">
                              {p.name.slice(0, 2).toUpperCase()}
                            </span>
                            <strong>{p.name}</strong>
                          </div>
                        </td>
                        <td>
                          <code>{p.service}</code>
                        </td>
                        {admin && (
                          <>
                            <td>
                              {
                                data.users.filter(
                                  (u) =>
                                    u.enabled &&
                                    (u.role === 'admin' || u.projects.includes(p.id)),
                                ).length
                              }
                            </td>
                            <td>
                              {
                                data.tokens.filter(
                                  (t) => !t.revoked && t.projectId === p.id,
                                ).length
                              }
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  {tab === 'People' &&
                    users.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.email}</strong>
                          {u.id === currentUser && (
                            <small className="ws-muted">You</small>
                          )}
                        </td>
                        <td>
                          <span className="ws-badge">
                            {u.role === 'admin' ? 'Administrator' : 'Developer'}
                          </span>
                        </td>
                        <td>
                          {u.role === 'admin'
                            ? 'All projects'
                            : u.projects.length
                              ? data.projects
                                  .filter((p) => u.projects.includes(p.id))
                                  .map((p) => p.name)
                                  .join(', ')
                              : 'No projects'}
                        </td>
                        <td>
                          <span className={`ws-badge ${u.enabled ? 'ws-active' : ''}`}>
                            {u.enabled ? 'Active' : 'Disabled'}
                          </span>
                        </td>
                        <td>
                          <button
                            className="button"
                            onClick={() => open({ kind: 'edit', user: u })}
                            aria-label={`Edit ${u.email}`}
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  {tab === 'Tokens' &&
                    tokens.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.label}</strong>
                          <small>
                            <code>{t.prefix}…</code>
                          </small>
                        </td>
                        <td>
                          {data.projects.find((p) => p.id === t.projectId)?.name ??
                            'Unknown project'}
                        </td>
                        <td>
                          {new Intl.DateTimeFormat('en-GB', {
                            dateStyle: 'medium',
                            timeZone: 'UTC',
                          }).format(new Date(t.createdAt))}
                        </td>
                        <td>
                          <span className={`ws-badge ${!t.revoked ? 'ws-active' : ''}`}>
                            {t.revoked ? 'Revoked' : 'Active'}
                          </span>
                        </td>
                        <td>
                          {!t.revoked && (
                            <button
                              className="button ws-danger"
                              onClick={() => open({ kind: 'revoke', token: t })}
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {!loading &&
              !(tab === 'Projects'
                ? projects.length
                : tab === 'People'
                  ? users.length
                  : tokens.length) && (
                <div className="ws-empty">
                  <strong>
                    {search || filter !== 'all'
                      ? 'No matching results'
                      : `No ${tab.toLowerCase()} yet`}
                  </strong>
                  <p>
                    {search || filter !== 'all'
                      ? 'Try a different search or filter.'
                      : tab === 'Projects'
                        ? 'Add a project to organize a backend service.'
                        : tab === 'Tokens'
                          ? 'Create a token to connect an application to its project.'
                          : 'Add your first team member.'}
                  </p>
                </div>
              )}
            <footer className="ws-panel-footer">
              {tab === 'Projects'
                ? 'The service name must match the name in your SDK configuration.'
                : tab === 'People'
                  ? 'Developers can investigate and replay incidents in their assigned projects.'
                  : 'Tokens only allow ingestion for their project. Rotate by creating a replacement before revoking the old token.'}
            </footer>
          </>
        )}
      </section>
      {modal && (
        <Dialog
          title={issued ? 'Your token is ready' : titles[modal.kind]}
          description={
            issued
              ? 'Copy this token now. You cannot view it again after closing this dialog.'
              : modal.kind === 'project'
                ? 'Give your backend service a dedicated place in this workspace.'
                : modal.kind === 'user'
                  ? 'Create an account and share its initial password privately. No invitation email is sent.'
                  : modal.kind === 'edit'
                    ? modal.user.email
                    : modal.kind === 'token'
                      ? 'Choose the project this application is allowed to send incidents to.'
                      : modal.kind === 'revoke'
                        ? 'Applications using this token will no longer be able to send incidents.'
                        : 'You will need to sign in again with your new password.'
          }
          close={close}
          busy={busy}
        >
          {error && (
            <p role="alert" className="ws-error">
              {error}
            </p>
          )}
          {issued ? (
            <div className="ws-token-reveal">
              <label>
                Ingestion token
                <textarea
                  readOnly
                  value={issued}
                  rows={3}
                  spellCheck={false}
                  onFocus={(event) => event.target.select()}
                />
              </label>
              <p className="ws-muted">
                Save it as authToken in your private credentials file. Keep it out of
                version control.
              </p>
              <div className="ws-dialog-actions">
                <button
                  className="button"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(issued)
                      .then(() => setCopied(true))
                      .catch(() =>
                        setError(
                          'Copy unavailable. Select the token and copy it manually.',
                        ),
                      );
                  }}
                >
                  {copied ? 'Copied' : 'Copy token'}
                </button>
                <button className="button primary" onClick={close}>
                  Done
                </button>
              </div>
              <span role="status" className="sr-only">
                {copied ? 'Token copied to clipboard.' : ''}
              </span>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                void perform(async () => {
                  if (modal.kind === 'project') {
                    await call('projects', 'POST', {
                      name: values.get('name'),
                      service: values.get('service'),
                    });
                    window.location.assign('/settings/workspace');
                    return;
                  }
                  if (modal.kind === 'user')
                    await call('users', 'POST', {
                      email: values.get('email'),
                      password: values.get('password'),
                      role,
                      projects: selected,
                    });
                  if (modal.kind === 'edit')
                    await call('users/' + modal.user.id, 'PUT', {
                      role,
                      enabled: values.get('enabled') === 'on',
                      projects: selected,
                      ...(values.get('password')
                        ? { password: values.get('password') }
                        : {}),
                    });
                  if (modal.kind === 'token') {
                    const result = await call(
                      'projects/' + values.get('project') + '/tokens',
                      'POST',
                      { label: values.get('label') },
                    );
                    setIssued(result.token);
                  }
                  if (modal.kind === 'revoke')
                    await call('tokens/' + modal.token.id, 'DELETE');
                  if (modal.kind === 'password') {
                    await call('password', 'POST', {
                      currentPassword: values.get('currentPassword'),
                      newPassword: values.get('newPassword'),
                    });
                    window.location.assign('/login');
                  }
                }, modal.kind === 'token');
              }}
            >
              <fieldset disabled={busy} className="ws-form-fields">
                {modal.kind === 'project' && (
                  <>
                    <label>
                      Project name
                      <input
                        name="name"
                        placeholder="My backend"
                        maxLength={80}
                        required
                        autoFocus
                      />
                    </label>
                    <label>
                      Service name
                      <input
                        name="service"
                        placeholder="my-backend-api"
                        maxLength={128}
                        required
                      />
                      <small>
                        Use the exact service name from your SDK configuration.
                      </small>
                    </label>
                  </>
                )}
                {(modal.kind === 'user' || modal.kind === 'edit') && (
                  <>
                    {modal.kind === 'user' && (
                      <label>
                        Email address
                        <input
                          name="email"
                          type="email"
                          maxLength={254}
                          required
                          autoFocus
                          placeholder="developer@company.com"
                        />
                      </label>
                    )}
                    <label>
                      Role
                      <select
                        value={role}
                        onChange={(event) => setRole(event.target.value)}
                      >
                        <option value="developer">Developer</option>
                        <option value="admin">Administrator</option>
                      </select>
                    </label>
                    {memberships()}
                    <label>
                      {modal.kind === 'user'
                        ? 'Initial password'
                        : 'Reset password (optional)'}
                      <input
                        name="password"
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={256}
                        required={modal.kind === 'user'}
                      />
                      <small>
                        {modal.kind === 'user'
                          ? 'At least 12 characters. Share this privately with the user.'
                          : 'Leave blank to keep their password. Resetting signs them out.'}
                      </small>
                    </label>
                    {modal.kind === 'edit' && (
                      <label className="ws-check">
                        <input
                          name="enabled"
                          type="checkbox"
                          defaultChecked={modal.user.enabled}
                        />
                        <span>
                          Account enabled
                          <small>
                            Disabling an account immediately removes its access.
                          </small>
                        </span>
                      </label>
                    )}
                  </>
                )}
                {modal.kind === 'token' && (
                  <>
                    <label>
                      Project
                      <select name="project" required defaultValue="">
                        <option value="" disabled>
                          Select a project
                        </option>
                        {data.projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} · {p.service}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Token label
                      <input
                        name="label"
                        placeholder="Production backend"
                        maxLength={80}
                        required
                      />
                    </label>
                    <p className="ws-muted">
                      This token cannot open the dashboard or manage the workspace.
                    </p>
                  </>
                )}
                {modal.kind === 'revoke' && (
                  <div className="ws-revoke-detail">
                    <strong>{modal.token.label}</strong>
                    <code>{modal.token.prefix}…</code>
                    <p>
                      Create and deploy a replacement first if this application still
                      needs to send incidents.
                    </p>
                  </div>
                )}
                {modal.kind === 'password' && (
                  <>
                    <label>
                      Current password
                      <input
                        name="currentPassword"
                        type="password"
                        autoComplete="current-password"
                        required
                        autoFocus
                      />
                    </label>
                    <label>
                      New password
                      <input
                        name="newPassword"
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={256}
                        required
                      />
                    </label>
                  </>
                )}
              </fieldset>
              <div className="ws-dialog-actions">
                <button type="button" className="button" disabled={busy} onClick={close}>
                  Cancel
                </button>
                <button
                  className={`button primary ${modal.kind === 'revoke' ? 'ws-danger' : ''}`}
                  disabled={busy || (modal.kind === 'token' && !data.projects.length)}
                >
                  {busy
                    ? 'Saving…'
                    : modal.kind === 'edit'
                      ? 'Save changes'
                      : modal.kind === 'password'
                        ? 'Change password and sign out'
                        : titles[modal.kind]}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
    </div>
  );
}
