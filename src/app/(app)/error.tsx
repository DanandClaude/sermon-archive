'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { PageHeader } from '@/components/shell/PageHeader';

/**
 * Anything unexpected inside the app. The message never shows error text (it can carry details
 * from the server); the reference matches the line in the server's log for whoever looks into it.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <>
      <PageHeader
        title="Something went wrong"
        description="This page couldn’t be shown. Nothing you saved was lost. Try again, and if it keeps happening, tell an admin."
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex h-11 items-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white"
        >
          Try again
        </button>
        <Link
          href="/library"
          className="inline-flex h-11 items-center px-3 text-[14.5px] font-semibold text-spruce"
        >
          Go to the library
        </Link>
      </div>
      {error.digest ? (
        <p className="m-0 text-[13px] text-muted">
          Reference for an admin: <span className="font-mono">{error.digest}</span>
        </p>
      ) : null}
    </>
  );
}
