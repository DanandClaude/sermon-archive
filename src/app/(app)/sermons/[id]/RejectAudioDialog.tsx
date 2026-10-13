'use client';

import { useId, useState, useTransition } from 'react';
import { rejectAudioAction } from './actions';

/**
 * Reject recording: for a tape that was cut short or is the wrong one. Asks why, then sets the
 * recording aside (it is kept, never deleted) so the full recording can be uploaded in its place.
 */
export function RejectAudioDialog({
  sermonId,
  onClose,
}: {
  sermonId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fieldId = useId();

  function reject() {
    setError(null);
    start(async () => {
      const result = await rejectAudioAction(sermonId, reason);
      if (result.ok) {
        onClose();
      } else {
        setError(result.fieldErrors?.reason ?? result.error);
      }
    });
  }

  return (
    <div
      role="alertdialog"
      aria-label="Reject this recording"
      className="w-[min(380px,100%)] rounded-xl border border-line-strong bg-surface p-4 text-[13.5px] shadow-sm"
    >
      <p className="m-0">
        Reject this recording if it is incomplete or the wrong tape. The file is kept, not deleted,
        and the details already entered stay. The sermon then waits for the full recording to be
        uploaded.
      </p>
      <label htmlFor={fieldId} className="mt-3 block font-semibold">
        What’s wrong with it?
      </label>
      <textarea
        id={fieldId}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={300}
        rows={3}
        placeholder="The recording stops partway through the sermon."
        aria-invalid={error ? true : undefined}
        className="mt-1.5 box-border w-full rounded-[10px] border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink"
      />
      {error ? (
        <p role="alert" className="mb-0 mt-2 font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl px-4 text-sm font-semibold text-spruce"
        >
          Not yet
        </button>
        <button
          type="button"
          onClick={reject}
          disabled={pending || !reason.trim()}
          className="h-11 rounded-xl bg-danger px-[18px] text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Rejecting…' : 'Reject recording'}
        </button>
      </div>
    </div>
  );
}
