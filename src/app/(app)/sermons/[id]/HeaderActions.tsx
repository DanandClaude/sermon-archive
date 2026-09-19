'use client';

import { useState, useTransition } from 'react';
import { approveAction } from './actions';
import { useReview } from './ReviewContext';

const FIELD_NAME: Record<string, string> = {
  recordedOn: 'the date',
  primaryPassage: 'the main passage',
  title: 'a title',
};

const listOf = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** Save draft and Approve & file. Approving saves any unsaved details first, then asks to confirm. */
export function HeaderActions({ canApprove }: { canApprove: boolean }) {
  const { sermonId, draft } = useReview();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const missing = Object.keys(draft?.problems ?? {}).map((k) => FIELD_NAME[k] ?? k);

  function saveDraft() {
    setMessage(null);
    start(async () => {
      const result = await draft?.save();
      if (result && !result.ok) setMessage(result.error);
    });
  }

  function approve() {
    setMessage(null);
    start(async () => {
      if (draft?.dirty) {
        const saved = await draft.save();
        if (!saved.ok) {
          setConfirming(false);
          return setMessage(saved.error);
        }
      }
      const result = await approveAction(sermonId);
      setConfirming(false);
      if (!result.ok) {
        setMessage(
          [result.error, ...Object.values(result.fieldErrors ?? {})].filter(Boolean).join(' '),
        );
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-3">
        {draft ? (
          <button
            type="button"
            onClick={saveDraft}
            disabled={pending || !draft.dirty}
            className="inline-flex h-11 items-center rounded-xl border border-line-strong bg-surface px-[18px] text-[14.5px] font-semibold disabled:opacity-50"
          >
            Save draft
          </button>
        ) : null}
        {canApprove ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={pending || missing.length > 0 || confirming}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white disabled:opacity-50"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
            Approve &amp; file
          </button>
        ) : null}
      </div>

      {canApprove && missing.length > 0 ? (
        <p className="m-0 max-w-[340px] text-right text-[13px] text-muted">
          To approve, add {listOf(missing)}.
        </p>
      ) : null}

      {confirming ? (
        <div
          role="alertdialog"
          aria-label="Confirm approval"
          className="w-[min(380px,100%)] rounded-xl border border-line-strong bg-surface p-4 text-[13.5px] shadow-sm"
        >
          <p className="m-0">
            Approve this sermon? It will be named{' '}
            <span className="break-all font-mono text-[12.5px]">{draft?.stem}</span> and shown to
            everyone in the library.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-11 rounded-xl px-4 text-sm font-semibold text-spruce"
            >
              Not yet
            </button>
            <button
              type="button"
              onClick={approve}
              disabled={pending}
              className="h-11 rounded-xl bg-spruce px-[18px] text-sm font-semibold text-white disabled:opacity-60"
            >
              {pending ? 'Approving…' : 'Approve'}
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p
          role="alert"
          className="m-0 max-w-[380px] text-right text-[13.5px] font-semibold text-danger"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
