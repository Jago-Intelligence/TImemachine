import { LoginForm } from '../../components/login-form';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Mark } from '../../components/shell';
import { dashboardConfig } from '../../lib/config';
import { COOKIE_NAME, validSession } from '../../lib/session';
export const dynamic = 'force-dynamic';
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const config = dashboardConfig();
  if (
    config.WORKSPACE_AUTH_MODE === 'legacy' &&
    validSession(
      (await cookies()).get(COOKIE_NAME)?.value,
      config.DASHBOARD_SESSION_SECRET,
    )
  )
    redirect('/');
  const query = await searchParams;
  return (
    <main className="login-page">
      <header className="login-top">
        <div className="brand">
          <Mark />
          <span className="wordmark">TimeMachine</span>
        </div>
      </header>
      <div className="login-form-area">
        <section className="login-card">
          <h2>Sign in</h2>
          <p className="login-lead">Access your TimeMachine workspace.</p>
          <LoginForm
            initialError={query.error === 'credentials'}
            accounts={config.WORKSPACE_AUTH_MODE === 'accounts'}
            adminEmail={config.WORKSPACE_ADMIN_EMAIL ?? ''}
          />
          <p className="login-help">
            {config.WORKSPACE_AUTH_MODE === 'accounts'
              ? 'Use the account provided by your workspace administrator.'
              : 'Use the password provided by your workspace administrator.'}
          </p>
          <p className="login-help">You’ll stay signed in for eight hours.</p>
        </section>
      </div>
      <footer className="login-bottom">
        <small>Your infrastructure. Your incidents. Your workspace.</small>
        <div className="login-ruler" aria-hidden="true">
          <span className="ruler-now">now</span>
          <span className="ruler-note">↙ all of this lives on your infrastructure</span>
        </div>
      </footer>
    </main>
  );
}
