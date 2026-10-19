'use client';
import { useState, type FormEvent } from 'react';
export function SignOut() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(false);
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        window.location.assign('/login');
        return;
      }
    } catch {
      /* Show a safe connection error. */
    }
    setPending(false);
    setError(true);
  }
  return (
    <form action="/auth/logout" method="post" onSubmit={submit}>
      <button className="sign-out" type="submit" disabled={pending}>
        {pending ? 'Signing out…' : 'Sign out'}
        <span aria-hidden="true">↗</span>
      </button>
      {error && <p role="alert">Could not sign out. Try again.</p>}
    </form>
  );
}
