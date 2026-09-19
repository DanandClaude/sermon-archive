'use client';

import { useState, useTransition } from 'react';
import { retryFilingAction } from './actions';

export function RetryFilingButton({ sermonId }: { sermonId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await retryFilingAction(sermonId);
            setError(result.ok ? null : result.error);
          })
        }
        className="inline-flex h-11 items-center self-start rounded-xl bg-spruce px-[18px] text-sm font-semibold text-white disabled:opacity-60"
      >
        {pending ? 'Queuing…' : 'File again'}
      </button>
      {error ? (
        <p role="alert" className="m-0 text-[13px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
