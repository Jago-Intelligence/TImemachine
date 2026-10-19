'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ThemeToggle } from './theme-toggle';
import { SignOut } from './sign-out';
import type { Project } from '../lib/project';
import { Mark } from './brand-mark';

function Icon({ kind }: { kind: 'issues' | 'alerts' | 'team' | 'menu' }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'issues' ? (
        <>
          <rect x="4" y="3" width="16" height="18" rx="3" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </>
      ) : kind === 'alerts' ? (
        <>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </>
      ) : kind === 'team' ? (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5" />
        </>
      ) : (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </>
      )}
    </svg>
  );
}
export function WorkspaceNavigation({
  projects,
  activeProject,
}: {
  projects?: Project[] | undefined;
  activeProject?: Project | undefined;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const [preference, setPreference] = useState<{ path: string; compact: boolean }>();
  const focused = pathname.startsWith('/issues/') || pathname.startsWith('/incidents/');
  const compact = preference?.path === pathname ? preference.compact : focused && mounted;
  const groups = [
    {
      label: 'Investigate',
      links: [{ href: '/', label: 'Issues', kind: 'issues' as const }],
    },
    {
      label: 'Manage',
      links: [
        {
          href: '/settings/notifications',
          label: 'Alerts',
          kind: 'alerts' as const,
        },
        { href: '/settings/workspace', label: 'Workspace & team', kind: 'team' as const },
      ],
    },
  ];
  return (
    <aside className="tm-sidebar" data-open={open} data-compact={compact}>
      <div className="tm-sidebar-brand">
        <Link href="/" aria-label="TimeMachine home">
          <Mark />
          <strong>TimeMachine</strong>
        </Link>
        <button
          className="tm-mobile-menu"
          type="button"
          aria-label="Toggle navigation"
          aria-controls="workspace-navigation"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon kind="menu" />
        </button>
      </div>
      <div className="tm-sidebar-body" id="workspace-navigation">
        {projects ? (
          <div className="tm-project-picker">
            <label htmlFor="active-project">Project</label>
            <select
              id="active-project"
              aria-label="Switch project"
              value={activeProject?.id ?? ''}
              disabled={switching || !projects.length}
              onChange={async (event) => {
                const projectId = event.target.value;
                setSwitching(true);
                setProjectError('');
                try {
                  const response = await fetch('/api/projects/select', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ projectId }),
                  });
                  if (!response.ok) throw new Error();
                  // Drop cursors, filters and detail IDs belonging to the prior project.
                  window.location.assign('/');
                } catch {
                  setProjectError('Could not switch project. Try again.');
                  setSwitching(false);
                }
              }}
            >
              {!projects.length && <option value="">No assigned projects</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {activeProject && (
              <small title={activeProject.service}>
                {switching ? 'Switching project…' : activeProject.service}
              </small>
            )}
            {projectError && <p role="alert">{projectError}</p>}
          </div>
        ) : (
          <Link
            href="/settings/workspace"
            className="tm-workspace-switch"
            onClick={() => setOpen(false)}
          >
            <span>
              <strong>Workspace</strong>
              <small>Self-hosted</small>
            </span>
            <span aria-hidden="true">›</span>
          </Link>
        )}
        <nav aria-label="Main navigation">
          {groups.map((group) => (
            <div className="tm-nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.links.map((link) => {
                const active =
                  link.href === '/'
                    ? pathname === '/' ||
                      pathname.startsWith('/issues/') ||
                      pathname.startsWith('/incidents/')
                    : pathname.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="tm-sidebar-link"
                    title={link.label}
                    aria-label={link.label}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                  >
                    <Icon kind={link.kind} />
                    <span>{link.label}</span>
                    {active && <span className="tm-nav-dot" aria-hidden="true" />}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="tm-sidebar-bottom">
          <div className="tm-sidebar-note">
            <strong>Every failure has a story.</strong>
            <p>Capture. Reproduce. Verify.</p>
          </div>
          <div className="tm-sidebar-controls">
            <button
              type="button"
              className="tm-collapse-toggle"
              aria-label={compact ? 'Expand sidebar' : 'Collapse sidebar'}
              title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!compact}
              aria-controls="workspace-navigation"
              onClick={() => setPreference({ path: pathname, compact: !compact })}
            >
              <Icon kind="menu" />
            </button>
            <ThemeToggle />
            <SignOut />
          </div>
        </div>
      </div>
    </aside>
  );
}

export function WorkspaceHeader({ projectName }: { projectName?: string | undefined }) {
  const pathname = usePathname();
  const workspaceWide = pathname.startsWith('/settings/notifications');
  const section = pathname.startsWith('/settings/notifications')
    ? 'Alerts'
    : pathname.startsWith('/settings/workspace')
      ? 'Workspace & team'
      : 'Issues';
  const detail = pathname.startsWith('/incidents/')
    ? 'Occurrence'
    : pathname.startsWith('/issues/')
      ? 'Issue detail'
      : undefined;
  return (
    <header className="tm-content-header">
      <nav aria-label="Breadcrumb" className="tm-breadcrumb">
        <Link href="/">{workspaceWide ? 'Workspace' : (projectName ?? 'Workspace')}</Link>
        <span aria-hidden="true">/</span>
        {detail ? (
          <Link href="/">{section}</Link>
        ) : (
          <span aria-current="page">{section}</span>
        )}
        {detail && (
          <>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{detail}</span>
          </>
        )}
      </nav>
      <span className="tm-host-label">Self-hosted workspace</span>
    </header>
  );
}
