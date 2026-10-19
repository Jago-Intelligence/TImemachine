import { requireSession } from '../../../lib/auth';
import { Shell } from '../../../components/shell';
import { WorkspaceSettings } from '../../../components/workspace-settings';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const session = await requireSession();
  return (
    <Shell>
      <h1>{session.activeProject?.name ?? 'Workspace'}</h1>
      {session.WORKSPACE_AUTH_MODE === 'accounts' ? (
        <WorkspaceSettings
          activeProjectName={session.activeProject?.name}
          admin={session.role === 'admin'}
          currentUser={session.user!.id}
        />
      ) : (
        <p>
          Individual accounts are disabled. Enable WORKSPACE_AUTH_MODE=accounts on the
          collector and dashboard after applying the workspace migration.
        </p>
      )}
    </Shell>
  );
}
