'use client';

import { useState, useTransition } from 'react';
import { formatClock } from '@/lib/format';
import { formatReference } from '@/lib/scripture/canon';
import type { ScriptureItem } from '@/lib/sermons/detail';
import { deletePassageAction } from './actions';
import { PassageDialog } from './PassageDialog';
import { usePlayback, useReview } from './ReviewContext';

/** Index of the passage being spoken about at `time`: the last one that started, or -1. */
export function currentPassage(items: ScriptureItem[], time: number): number {
  let found = -1;
  items.forEach((item, i) => {
    if (item.spokenAtSec <= time) found = i;
  });
  return found;
}

const iconButton =
  'flex size-11 flex-none items-center justify-center rounded-[10px] text-muted hover:bg-chip';

export function ScripturePanel({ items, canEdit }: { items: ScriptureItem[]; canEdit: boolean }) {
  const { sermonId } = useReview();
  const { time, seek } = usePlayback();
  const [dialog, setDialog] = useState<{ open: boolean; item: ScriptureItem | null }>({
    open: false,
    item: null,
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const active = time > 0 ? currentPassage(items, time) : -1;

  function remove(id: string) {
    start(async () => {
      const result = await deletePassageAction(sermonId, id);
      if (result.ok) setConfirming(null);
      else setError(result.error);
    });
  }

  return (
    <section
      aria-labelledby="refs-h"
      className="rounded-2xl border border-line bg-surface px-6 pb-[22px] pt-5"
    >
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <h2 id="refs-h" className="m-0 text-[17px] font-semibold">
            Scripture references
          </h2>
          <p className="mb-0 mt-[3px] text-[13px] text-muted">
            Passages the pastor names out loud.{' '}
            {canEdit
              ? 'Jump to any of them, or use the pencil to correct one.'
              : 'Select one to jump to it.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex h-[26px] items-center rounded-full bg-spruce-tint px-2.5 text-[12.5px] font-semibold text-spruce">
            {items.length} {items.length === 1 ? 'passage' : 'passages'}
          </span>
          {canEdit ? (
            <button
              type="button"
              onClick={() => setDialog({ open: true, item: null })}
              className="inline-flex h-11 items-center gap-1.5 px-3 text-[13.5px] font-semibold text-spruce"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              Add passage
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="mb-3 mt-0 text-[13.5px] font-semibold text-danger">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="m-0 rounded-xl border border-dashed border-line-strong bg-paper px-4 py-5 text-[14px] text-muted">
          No passages were named in this recording.
          {canEdit ? ' If the pastor did name one, use Add passage.' : ''}
        </p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-x-3 gap-y-2.5 p-0 md:grid-cols-2">
          {items.map((item, i) => {
            const name = formatReference(item.ref);
            const isActive = i === active;
            return (
              <li
                key={item.id}
                aria-current={isActive ? 'true' : undefined}
                className={`flex min-h-[60px] items-center gap-0.5 rounded-xl border pr-1.5 ${
                  isActive ? 'border-[#b7cfc8] bg-spruce-mid' : 'border-chip bg-surface'
                }`}
              >
                {confirming === item.id ? (
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 px-3 py-2">
                    <span className="text-[13.5px]">Remove {name}?</span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => remove(item.id)}
                      className="h-11 rounded-[10px] bg-danger px-3.5 text-[13.5px] font-semibold text-white disabled:opacity-60"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="h-11 rounded-[10px] px-3 text-[13.5px] font-semibold text-spruce"
                    >
                      Keep
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => seek(item.spokenAtSec)}
                      aria-label={`Jump to ${formatClock(item.spokenAtSec)}, ${name}`}
                      className="flex min-h-[58px] min-w-0 flex-1 items-center gap-3 py-1 pl-3 text-left"
                    >
                      <span
                        className={`inline-flex h-7 w-14 flex-none items-center justify-center rounded-lg font-mono text-[12.5px] font-medium ${
                          isActive ? 'bg-spruce text-white' : 'bg-chip text-[#3d3930]'
                        }`}
                      >
                        {formatClock(item.spokenAtSec)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 text-[14.5px] font-semibold">
                          {name}
                          {item.isMainText ? (
                            <span className="rounded-full bg-spruce-tint px-2 text-[11.5px] font-semibold text-spruce">
                              Main text
                            </span>
                          ) : null}
                          {item.source === 'manual' || item.edited ? (
                            <span className="rounded-full bg-chip px-2 text-[11.5px] font-semibold text-muted">
                              {item.source === 'manual' ? 'Added' : 'Edited'}
                            </span>
                          ) : null}
                        </span>
                        {item.contextNote ? (
                          <span className="block truncate text-[12.5px] text-muted">
                            {item.contextNote}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {canEdit ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setDialog({ open: true, item })}
                          aria-label={`Edit ${name}`}
                          className={iconButton}
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M4 20h4L19 9l-4-4L4 16z" />
                            <path d="M13.5 6.5l4 4" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(item.id)}
                          aria-label={`Remove ${name}`}
                          className={iconButton}
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M5 7h14" />
                            <path d="M9 7V4.5h6V7" />
                            <path d="M7 7l1 12.5h8L17 7" />
                          </svg>
                        </button>
                      </>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit ? (
        <PassageDialog
          item={dialog.item}
          open={dialog.open}
          onClose={() => setDialog((d) => ({ ...d, open: false }))}
        />
      ) : null}
    </section>
  );
}
