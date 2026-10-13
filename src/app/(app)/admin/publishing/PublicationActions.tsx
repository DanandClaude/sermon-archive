'use client';

import { useState, useTransition } from 'react';
import { canRetry, canUnpublish } from '@/lib/distribution/labels';
import type { ChannelKind, PublicationState } from '@/lib/distribution/states';
import { retryPublicationAction, unpublishAction } from './actions';

/** Unpublish (or cancel) and Try again for one publication, with a confirmation before unpublishing. */
export function PublicationActions({
  id,
  state,
  channel,
}: {
  id: string;
  state: PublicationState;
  channel: ChannelKind;
}) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = state === 'published';
  const removeLabel = live ? 'Unpublish' : 'Cancel';

  const run = (work: () => ReturnType<typeof unpublishAction>) =>
    start(async () => {
      const result = await work();
      setConfirming(false);
      setError(result.ok ? null : result.error);
    });

  if (!canUnpublish(state) && !canRetry(state)) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      {confirming ? (
        <div className="rounded-xl bg-amber-tint px-3.5 py-3 text-[13.5px] text-amber-text">
          <p className="m-0">
            {channel === 'youtube'
              ? live
                ? 'Make this video private on YouTube? It is not deleted, and you can publish it again.'
                : 'Stop this upload? Nothing has gone to YouTube yet.'
              : 'Take this episode out of the podcast feed? Its audio link stops working. Copies people already downloaded stay on their devices.'}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => unpublishAction(id))}
              className="h-11 rounded-xl bg-danger px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              {pending ? 'Working…' : removeLabel}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-11 px-3 text-sm font-semibold text-spruce"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {canRetry(state) ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => retryPublicationAction(id))}
              className="inline-flex h-11 items-center rounded-xl bg-spruce px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              Try again
            </button>
          ) : null}
          {canUnpublish(state) ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="h-11 px-3 text-sm font-semibold text-danger"
            >
              {removeLabel}
            </button>
          ) : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="m-0 text-[13px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
