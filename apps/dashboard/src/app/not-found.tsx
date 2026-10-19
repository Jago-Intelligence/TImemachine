import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="standalone-state">
      <span className="eyebrow">NOT FOUND</span>
      <h1>This item isn’t available.</h1>
      <p>
        The link may be incorrect, the capture may have expired, or a different project
        may be selected. Return to issues to choose a project.
      </p>
      <Link href="/" className="button primary">
        Return to issues
      </Link>
    </main>
  );
}
