import { requireSession } from '../lib/auth';
import { RefreshButton } from './refresh-button';
import { WorkspaceNavigation, WorkspaceHeader } from './workspace-navigation';
import type { ReactNode } from 'react';
export { Mark } from './brand-mark';
export async function Shell({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <div className="workspace tm-sidebar-layout">
      <a className="tm-skip-link" href="#workspace-content">
        Skip to content
      </a>
      <WorkspaceNavigation
        projects={session.projects}
        activeProject={session.activeProject}
      />
      <div className="main-area">
        <WorkspaceHeader projectName={session.activeProject?.name} />
        <main id="workspace-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
export function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status === 'candidate' ? 'candidate' : 'unsupported'}`}>
      <span className="status-dot" />
      {status === 'candidate' ? 'Replay candidate' : 'Capture only'}
    </span>
  );
}
export function timeLabel(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(value));
}
export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="notice" role="status">
      <span className="notice-icon" aria-hidden="true">
        ↶
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      <RefreshButton label="Refresh incidents" />
    </section>
  );
}
