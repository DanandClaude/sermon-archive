'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function RetryButton({ sermonId }: { sermonId: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });

  async function retry() {
    setState({ busy: true });
    try {
      const res = await fetch(`/api/sermons/${sermonId}/retry`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok)
        return setState({
          busy: false,
          error: (await res.json()).error ?? 'That could not be retried.',
        });
      router.refresh();
      setState({ busy: false });
    } catch {
      setState({ busy: false, error: 'The connection dropped. Try again in a moment.' });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={retry}
        disabled={state.busy}
        className="inline-flex h-11 items-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white disabled:opacity-60"
      >
        {state.busy ? 'Retrying…' : 'Retry'}
      </button>
      {state.error ? (
        <p role="alert" className="m-0 text-[13px] font-semibold text-danger">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
