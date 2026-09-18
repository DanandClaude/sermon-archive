'use client';

import { useMemo, useRef, useState } from 'react';
import { formatClock } from '@/lib/format';
import type { Segment } from '@/lib/transcripts/render';

type Source = 'cleaned' | 'original';

/** Index of the segment being spoken at `time`, or -1 before the first one. */
function segmentAt(segments: Segment[], time: number): number {
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

export function SermonPlayer({
  originalUrl,
  cleanedUrl,
  segments,
  lowConfidence,
}: {
  originalUrl: string;
  cleanedUrl: string | null;
  segments: Segment[];
  lowConfidence: [number, number][];
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const resume = useRef<{ time: number; play: boolean } | null>(null);
  const [source, setSource] = useState<Source>(cleanedUrl ? 'cleaned' : 'original');
  const [active, setActive] = useState(-1);
  const doubtful = useMemo(
    () => new Set(lowConfidence.map(([i, j]) => `${i}:${j}`)),
    [lowConfidence],
  );

  function choose(next: Source) {
    if (next === source) return;
    const el = audio.current;
    // Remember the position so the other version carries on from the same spot.
    resume.current = el ? { time: el.currentTime, play: !el.paused } : null;
    setSource(next);
  }

  function seek(time: number) {
    const el = audio.current;
    if (!el) return;
    el.currentTime = time;
    void el.play();
  }

  const src = source === 'cleaned' && cleanedUrl ? cleanedUrl : originalUrl;

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-line bg-surface px-6 py-[22px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-[17px] font-semibold">Listen</h2>
          <div
            role="radiogroup"
            aria-label="Which recording to play"
            className="inline-flex rounded-xl border border-line-strong p-1"
          >
            {(['original', 'cleaned'] as const).map((s) => {
              const disabled = s === 'cleaned' && !cleanedUrl;
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={source === s}
                  disabled={disabled}
                  onClick={() => choose(s)}
                  className={`inline-flex h-11 items-center rounded-[9px] px-4 text-[14px] font-semibold disabled:opacity-40 ${
                    source === s ? 'bg-spruce text-white' : 'text-ink'
                  }`}
                >
                  {s === 'original' ? 'Original tape' : 'Cleaned'}
                </button>
              );
            })}
          </div>
        </div>
        <audio
          ref={audio}
          key={src}
          src={src}
          controls
          preload="metadata"
          className="mt-4 w-full"
          onLoadedMetadata={(e) => {
            const pending = resume.current;
            if (!pending) return;
            resume.current = null;
            e.currentTarget.currentTime = pending.time;
            if (pending.play) void e.currentTarget.play();
          }}
          onTimeUpdate={(e) => {
            const index = segmentAt(segments, e.currentTarget.currentTime);
            setActive((prev) => (prev === index ? prev : index));
          }}
        />
        {!cleanedUrl ? (
          <p className="mb-0 mt-2 text-[13px] text-muted">
            The cleaned version appears here once processing finishes.
          </p>
        ) : null}
      </div>

      {segments.length > 0 ? (
        <section
          aria-label="Transcript"
          className="rounded-2xl border border-line bg-surface px-6 py-[22px]"
        >
          <p className="m-0 text-[13px] text-muted">
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
      ) : null}
    </div>
  );
}
