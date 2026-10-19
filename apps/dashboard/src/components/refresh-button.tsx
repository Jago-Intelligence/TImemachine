'use client';
export function RefreshButton({
  href = '/',
  label = 'Refresh',
}: {
  href?: string;
  label?: string;
}) {
  return (
    <button className="button" type="button" onClick={() => window.location.assign(href)}>
      <span aria-hidden="true">↻</span>
      {label}
    </button>
  );
}
