'use client';

import { useId, useMemo, useState, useSyncExternalStore } from 'react';
import { formatClock } from '@/lib/format';
import type { Segment } from '@/lib/transcripts/render';
import { usePlayback } from './ReviewContext';

/** Index of the segment being spoken at `time`, or -1 before the first one. */
export function segmentAt(segments: Segment[], time: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const OPEN_KEY = 'sermon-archive:transcript-open';

function readStoredOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function TranscriptPanel({
  segments,
  lowConfidence,
}: {
  segments: Segment[];
  lowConfidence: [number, number][];
}) {
  const { time, seek } = usePlayback();
  const active = segmentAt(segments, time);
  const bodyId = useId();
  const doubtful = useMemo(
    () => new Set(lowConfidence.map(([i, j]) => `${i}:${j}`)),
    [lowConfidence],
  );
  // Closed to begin with, so the page is short; the choice is remembered for next time.
  const stored = useSyncExternalStore(
    () => () => {},
    readStoredOpen,
    () => false,
  );
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? stored;
  function toggle() {
    setChosen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? '0' : '1');
    } catch {
      // Storage can be blocked (private windows). It still opens and closes, just not remembered.
    }
  }

  return (
    <section
      aria-label="Transcript"
      className="rounded-2xl border border-line bg-surface px-6 py-[22px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-[17px] font-semibold">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={bodyId}
            className="-mx-2 flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-[17px] font-semibold"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={`flex-none transition-transform ${open ? 'rotate-90' : ''}`}
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            Transcript
            <span className="sr-only">{open ? ' (hide)' : ' (show)'}</span>
          </button>
        </h2>
        {lowConfidence.length > 0 ? (
          <span className="inline-flex h-[26px] items-center rounded-full bg-amber-tint px-2.5 text-[12.5px] font-semibold text-amber-text">
            {lowConfidence.length} {lowConfidence.length === 1 ? 'word' : 'words'} to check
          </span>
        ) : null}
      </div>
      {!open && time > 0 && active >= 0 ? (
        <p className="mb-0 mt-1 truncate text-[13.5px] text-muted" aria-live="off">
          <span className="font-mono text-spruce">{formatClock(segments[active].start)}</span>{' '}
          {segments[active].text}
        </p>
      ) : null}
      <div id={bodyId} hidden={!open}>
        <p className="mb-0 mt-1.5 text-[13px] text-muted">
          Select a time to jump there. Words the transcriber wasn’t sure of are underlined.
        </p>
        <ol className="m-0 mt-3 list-none p-0">
          {segments.map((segment, i) => (
            <li
              key={i}
              aria-current={active === i ? 'true' : undefined}
              className={`flex gap-4 rounded-xl px-3 py-2.5 ${active === i ? 'bg-spruce-mid' : ''}`}
            >
              <button
                type="button"
                onClick={() => seek(segment.start)}
                className="h-11 flex-none self-start rounded-lg px-2 font-mono text-[13px] font-medium text-spruce"
              >
                {formatClock(segment.start)}
                <span className="sr-only"> Play from here</span>
              </button>
              <p className="m-0 min-w-0 flex-1 self-center text-[15px] leading-[1.6]">
                {segment.words.length > 0
                  ? segment.words.map((word, j) => (
                      <span key={j}>
                        {j > 0 ? ' ' : ''}
                        {doubtful.has(`${i}:${j}`) ? (
                          <span
                            title="The transcriber wasn’t sure of this word"
                            className="underline decoration-amber-underline decoration-dotted decoration-2 underline-offset-4"
                          >
                            {word.w}
                          </span>
                        ) : (
                          word.w
                        )}
                      </span>
                    ))
                  : segment.text}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
