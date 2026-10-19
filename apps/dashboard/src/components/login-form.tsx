'use client';
import { useState, type FormEvent } from 'react';
export function LoginForm({
  initialError,
  accounts = false,
  adminEmail = '',
}: {
  initialError: boolean;
  accounts?: boolean;
  adminEmail?: string;
}) {
  const [pending, setPending] = useState(false);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState(
    initialError ? 'That password didn’t match. Try again.' : '',
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = values.get('password');
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          password: typeof password === 'string' ? password : '',
          ...(accounts ? { email: String(values.get('email') ?? '') } : {}),
        }),
      });
      if (response.ok) {
        window.location.assign('/');
        return;
      }
      setError(
        response.status === 429
          ? 'Too many attempts. Wait a minute, then try again.'
          : response.status === 401
            ? 'That password didn’t match. Try again.'
            : 'Sign-in is unavailable. Check the workspace URL and try again.',
      );
    } catch {
      setError('Could not reach the dashboard. Try again.');
    }
    setPending(false);
  }
  return (
    <form action="/auth/login" method="post" onSubmit={submit}>
      {accounts && (
        <div className="login-field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            defaultValue={adminEmail}
            placeholder="you@company.com"
          />
        </div>
      )}
      <div className="login-field">
        <label htmlFor="password">{accounts ? 'Password' : 'Workspace password'}</label>
        <div className="password-field">
          <input
            id="password"
            name="password"
            type={shown ? 'text' : 'password'}
            placeholder="Enter your password"
            autoComplete="current-password"
            required
            maxLength={256}
            autoFocus
          />
          <button
            type="button"
            className="password-toggle"
            onClick={() => setShown((value) => !value)}
            aria-pressed={shown}
          >
            {shown ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button primary full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
