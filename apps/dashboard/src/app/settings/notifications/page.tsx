export const dynamic = 'force-dynamic';
import { requireSession } from '../../../lib/auth';
import { Shell } from '../../../components/shell';
import { NotificationSettings } from '../../../components/notification-settings';
export default async function Page() {
  const session = await requireSession();
  if (session.role !== 'admin')
    return (
      <Shell>
        <h1>Alerts</h1>
        <p>Administrator access is required to manage alert credentials.</p>
      </Shell>
    );
  return (
    <Shell>
      <h1>Alerts</h1>
      <p className="workspace-wide-note">
        Workspace-wide settings. These destinations receive alerts from all projects;
        switching projects does not change delivery settings.
      </p>
      <NotificationSettings />
    </Shell>
  );
}
