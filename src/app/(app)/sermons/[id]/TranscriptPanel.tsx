'use client';

import { useMemo } from 'react';
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

export function TranscriptPanel({
  segments,
  lowConfidence,
}: {
  segments: Segment[];
  lowConfidence: [number, number][];
}) {
  const { time, seek } = usePlayback();
  const active = segmentAt(segments, time);
  const doubtful = useMemo(
    () => new Set(lowConfidence.map(([i, j]) => `${i}:${j}`)),
    [lowConfidence],
  );

  return (
    <section
      aria-label="Transcript"
      className="rounded-2xl border border-line bg-surface px-6 py-[22px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-[17px] font-semibold">Transcript</h2>
        {lowConfidence.length > 0 ? (
          <span className="inline-flex h-[26px] items-center rounded-full bg-amber-tint px-2.5 text-[12.5px] font-semibold text-amber-text">
            {lowConfidence.length} {lowConfidence.length === 1 ? 'word' : 'words'} to check
          </span>
        ) : null}
      </div>
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
    </section>
  );
}
