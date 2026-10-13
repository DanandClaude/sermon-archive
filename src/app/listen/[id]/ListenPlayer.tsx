'use client';

import { useEffect, useRef, useState } from 'react';
import type { LibraryPassage } from '@/lib/distribution/library';
import { formatClock } from '@/lib/format';

const SPEEDS = [1, 1.25, 1.5, 0.75];

const card = 'rounded-2xl border border-line bg-surface px-5 py-5';
const heading = 'm-0 mb-3 text-[17px] font-semibold';
const round =
  'flex size-11 flex-none items-center justify-center rounded-full border border-line-strong bg-surface text-[12.5px] font-bold text-ink';

/** Index of the line being spoken at `time`: the last one that started at or before it. */
export function currentLine(starts: number[], time: number): number {
  let found = -1;
  for (let i = 0; i < starts.length && starts[i] <= time; i++) found = i;
  return found;
}

/**
 * The public player: play, skip, speed, and a transcript that follows along. Tapping a passage or
 * a transcript line jumps there.
 */
export function ListenPlayer({
  src,
  durationSec,
  summary,
  passages,
  segments,
}: {
  src: string;
  durationSec: number | null;
  summary: string | null;
  passages: LibraryPassage[];
  segments: { start: number; text: string }[];
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(durationSec ?? 0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [broken, setBroken] = useState(false);
  const [follow, setFollow] = useState(true);
  const lines = useRef<(HTMLLIElement | null)[]>([]);
  const current = currentLine(
    segments.map((s) => s.start),
    time,
  );

  useEffect(() => {
    if (!follow || !playing || current < 0) return;
    lines.current[current]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [current, follow, playing]);

  function seek(to: number, play = true) {
    const el = audio.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(to, length || to));
    setTime(el.currentTime);
    if (play) void el.play();
  }

  function toggle() {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  }

  return (
    <div className="mt-6 flex flex-col gap-5">
      <section aria-label="Audio player" className={card}>
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            if (Number.isFinite(e.currentTarget.duration)) setLength(e.currentTarget.duration);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => setBroken(true)}
        />
        {broken ? (
          <p
            role="alert"
            className="mb-4 mt-0 rounded-xl bg-amber-tint px-3.5 py-3 text-[13.5px] text-amber-text"
          >
            This recording can’t be played right now. Try again in a little while, or in another
            browser.
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            className="flex size-14 flex-none items-center justify-center rounded-full bg-spruce text-white"
          >
            {playing ? (
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <rect x="4" y="3" width="4" height="14" rx="1" fill="currentColor" />
                <rect x="12" y="3" width="4" height="14" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M6 3.5v13l11-6.5z" fill="currentColor" />
              </svg>
            )}
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <input
              type="range"
              aria-label="Position"
              min={0}
              max={Math.max(1, Math.floor(length))}
              step={1}
              value={Math.floor(time)}
              onChange={(e) => seek(Number(e.target.value), false)}
              className="h-11 w-full accent-spruce"
            />
            <div className="flex justify-between font-mono text-[12.5px] text-muted">
              <span>{formatClock(time)}</span>
              <span>{length ? formatClock(length) : '--:--'}</span>
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => seek(time - 15, false)}
            aria-label="Back 15 seconds"
            className={round}
          >
            −15
          </button>
          <button
            type="button"
            onClick={() => seek(time + 30, false)}
            aria-label="Forward 30 seconds"
            className={round}
          >
            +30
          </button>
          <button
            type="button"
            onClick={cycleSpeed}
            aria-label={`Playback speed ${speed} times`}
            className={`${round} w-auto px-3.5`}
          >
            {speed}×
          </button>
        </div>
      </section>

      {summary ? (
        <section aria-labelledby="summary-h" className={card}>
          <h2 id="summary-h" className={heading}>
            Summary
          </h2>
          <p className="m-0 text-[15px] leading-relaxed">{summary}</p>
        </section>
      ) : null}

      {passages.length ? (
        <section aria-labelledby="passages-h" className={card}>
          <h2 id="passages-h" className={heading}>
            Passages
          </h2>
          <ul className="m-0 flex list-none flex-col p-0">
            {passages.map((p, i) => (
              <li key={i} className="border-t border-chip first:border-t-0">
                {p.spokenAtSec !== null ? (
                  <button
                    type="button"
                    onClick={() => seek(p.spokenAtSec!)}
                    className="flex min-h-11 w-full items-center justify-between gap-3 text-left text-[15px]"
                  >
                    <span className={p.isMainText ? 'font-semibold' : ''}>{p.label}</span>
                    <span className="font-mono text-[12.5px] text-spruce">
                      {formatClock(p.spokenAtSec)}
                    </span>
                  </button>
                ) : (
                  <span className="flex min-h-11 items-center text-[15px]">{p.label}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {segments.length ? (
        <section aria-labelledby="transcript-h" className={card}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="transcript-h" className="m-0 text-[17px] font-semibold">
              Transcript
            </h2>
            <label className="flex min-h-11 items-center gap-2 text-[13px] text-muted">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
                className="size-[18px] accent-spruce"
              />
              Follow along
            </label>
          </div>
          <p className="mb-3 mt-0 text-[12.5px] text-muted">
            Made by computer from the tape, so a few words may be wrong.
          </p>
          <ol className="m-0 max-h-[60vh] list-none overflow-y-auto p-0">
            {segments.map((s, i) => (
              <li
                key={i}
                ref={(el) => {
                  lines.current[i] = el;
                }}
              >
                <button
                  type="button"
                  onClick={() => seek(s.start)}
                  aria-current={i === current ? 'true' : undefined}
                  className={`flex w-full gap-3 rounded-lg px-2 py-1.5 text-left text-[15px] leading-relaxed ${i === current ? 'bg-spruce-tint' : ''}`}
                >
                  <span className="w-12 flex-none pt-[3px] font-mono text-[12px] text-muted">
                    {formatClock(s.start)}
                  </span>
                  <span>{s.text.trim()}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
