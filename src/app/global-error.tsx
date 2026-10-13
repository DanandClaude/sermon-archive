'use client';

/**
 * The last resort, when even the page frame fails. It draws its own document with inline styles,
 * since the app's stylesheet may be what failed.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: '#F6F3EC',
          color: '#1E1D1A',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <title>Something went wrong · Sermon Archive</title>
        <main style={{ maxWidth: 480, margin: '0 auto', padding: '20vh 16px' }}>
          <h1 style={{ fontSize: 26, margin: '0 0 12px' }}>Something went wrong</h1>
          <p style={{ fontSize: 15, color: '#5E584E', margin: '0 0 20px' }}>
            The archive couldn’t load. Nothing you saved was lost. Try again in a moment, and if it
            keeps happening, tell an admin.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              height: 44,
              padding: '0 20px',
              border: 0,
              borderRadius: 12,
              background: '#1F5C52',
              color: '#fff',
              fontSize: 14.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p style={{ fontSize: 13, color: '#5E584E', marginTop: 20 }}>
              Reference for an admin: <code>{error.digest}</code>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
