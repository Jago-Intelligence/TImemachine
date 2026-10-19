'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="standalone-state">
      <span className="eyebrow">WORKSPACE UNAVAILABLE</span>
      <h1>Something interrupted this view.</h1>
      <p>Check the dashboard configuration and collector connection, then try again.</p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
