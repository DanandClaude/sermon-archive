'use client';

import { useState, useTransition } from 'react';
import { regenerateSummaryAction, saveSummaryAction } from './actions';
import { useReview } from './ReviewContext';

const button =
  'inline-flex h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold disabled:opacity-60';

export function SummaryCard({
  summary,
  canEdit,
  canRegenerate,
}: {
  summary: { text: string; source: 'auto' | 'edited' } | null;
  canEdit: boolean;
  canRegenerate: boolean;
}) {
  const { sermonId } = useReview();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(summary?.text ?? '');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    start(async () => {
      const result = await saveSummaryAction(sermonId, text);
      if (result.ok) setEditing(false);
      else setError(result.fieldErrors?.summary ?? result.error);
    });
  }

  function regenerate() {
    setError(null);
    start(async () => {
      const result = await regenerateSummaryAction(sermonId);
      if (!result.ok) setError(result.error);
      setConfirming(false);
    });
  }

  return (
    <section
      aria-labelledby="sum-h"
      className="rounded-2xl border border-line bg-surface px-[22px] py-5"
    >
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 id="sum-h" className="m-0 text-[17px] font-semibold">
          Summary
        </h2>
        {summary ? (
          <span className="inline-flex h-[22px] items-center rounded-full bg-spruce-tint px-2 text-[11.5px] font-semibold text-spruce">
            {summary.source === 'edited' ? 'Edited' : 'Auto-generated'}
          </span>
        ) : null}
      </div>

      {editing ? (
        <div>
          <label htmlFor="summary-text" className="sr-only">
            Summary
          </label>
          <textarea
            id="summary-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            maxLength={2000}
            className="box-border w-full rounded-[10px] border border-line-strong bg-surface p-3 text-sm leading-[1.6] text-ink"
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className={`${button} bg-spruce text-white`}
            >
              {pending ? 'Saving…' : 'Save summary'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setText(summary?.text ?? '');
                setError(null);
              }}
              className={`${button} text-spruce`}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="m-0 whitespace-pre-line text-sm leading-[1.6] text-[#2b2a26]">
            {summary?.text ?? 'There is no summary yet.'}
          </p>
          {canEdit || canRegenerate ? (
            <div className="mt-3.5 flex flex-wrap gap-2">
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => {
                    setText(summary?.text ?? '');
                    setEditing(true);
                  }}
                  className={`${button} border border-line-strong bg-surface text-ink`}
                >
                  Edit
                </button>
              ) : null}
              {canRegenerate && !confirming ? (
                <button
                  type="button"
                  onClick={() =>
                    summary?.source === 'edited' ? setConfirming(true) : regenerate()
                  }
                  disabled={pending}
                  className={`${button} text-spruce`}
                >
                  Regenerate
                </button>
              ) : null}
            </div>
          ) : null}
          {confirming ? (
            <div className="mt-3 rounded-xl bg-amber-tint px-3.5 py-3 text-[13.5px] text-amber-text">
              <p className="m-0">This replaces the summary you edited with a new one.</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={regenerate}
                  disabled={pending}
                  className={`${button} bg-spruce text-white`}
                >
                  Replace it
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className={`${button} text-spruce`}
                >
                  Keep mine
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="mb-0 mt-3 text-[13.5px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
