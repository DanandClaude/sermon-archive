'use client';

import { useEffect, useRef, useState } from 'react';
import { formatClock } from '@/lib/format';
import type { Peaks } from '@/lib/sermons/peaks';
import { usePlayback, useTime } from './ReviewContext';
import { Waveform } from './Waveform';

type Source = 'cleaned' | 'original';
const SPEEDS = [1, 1.25, 1.5, 0.75];

const transport =
  'flex size-11 items-center justify-center rounded-full border border-line-strong bg-surface text-[12.5px] font-bold text-ink';

export function SermonPlayer({
  originalUrl,
  cleanedUrl,
  originalPeaks,
  cleanedPeaks,
  durationSec,
}: {
  originalUrl: string;
  cleanedUrl: string | null;
  originalPeaks: Peaks | null;
  cleanedPeaks: Peaks | null;
  durationSec: number | null;
}) {
  const { audioRef, setTime, seek } = usePlayback();
  const time = useTime();
  const resume = useRef<{ time: number; play: boolean } | null>(null);
  const [source, setSource] = useState<Source>(cleanedUrl ? 'cleaned' : 'original');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [length, setLength] = useState(durationSec ?? 0);
  // Recordings this browser could not decode. Old tape files are sometimes MPEG Layer II saved
  // as .mp3, which Chrome-based browsers can't play (the cleaned copy is always a true MP3).
  const [unplayable, setUnplayable] = useState<Source[]>([]);
  const latestTime = useRef(0);
  useEffect(() => {
    latestTime.current = time;
  });

  function failed(bad: Source) {
    const other: Source = bad === 'cleaned' ? 'original' : 'cleaned';
    const canFallBack = !(other === 'cleaned' && !cleanedUrl) && !unplayable.includes(other);
    setUnplayable((list) => (list.includes(bad) ? list : [...list, bad]));
    setPlaying(false);
    if (!canFallBack) return;
    // Carry on from where the listener was, in the version that does play.
    resume.current = { time: latestTime.current, play: false };
    setSource(other);
  }

  function choose(next: Source) {
    if (next === source || unplayable.includes(next)) return;
    const el = audioRef.current;
    // Remember the position so the other version carries on from the same spot.
    resume.current = el ? { time: el.currentTime, play: !el.paused } : null;
    setSource(next);
  }

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  const src = source === 'cleaned' && cleanedUrl ? cleanedUrl : originalUrl;
  const skip = (by: number) => seek((audioRef.current?.currentTime ?? 0) + by, false);

  return (
    <section
      aria-label="Audio player"
      className="rounded-2xl border border-line bg-surface px-6 pb-[22px] pt-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          role="radiogroup"
          aria-label="Which recording to play"
          className="inline-flex gap-1 rounded-xl bg-[#eae4d8] p-1"
        >
          {(['original', 'cleaned'] as const).map((s) => {
            const disabled = (s === 'cleaned' && !cleanedUrl) || unplayable.includes(s);
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={source === s}
                disabled={disabled}
                onClick={() => choose(s)}
                className={`inline-flex h-11 items-center rounded-[9px] px-4 text-[13.5px] font-semibold disabled:opacity-40 ${
                  source === s ? 'bg-surface text-ink' : 'text-muted'
                }`}
              >
                {s === 'original' ? 'Original tape' : 'Cleaned'}
              </button>
            );
          })}
        </div>
        {!cleanedUrl ? (
          <span className="text-[13px] text-muted">
            The cleaned version appears here once processing finishes.
          </span>
        ) : null}
      </div>
      {unplayable.length > 0 ? (
        <p
          role="alert"
          className="mb-4 mt-0 rounded-xl bg-amber-tint px-3.5 py-3 text-[13.5px] leading-[1.5] text-amber-text"
        >
          {unplayable.length === 2
            ? 'This browser can’t play either version of this recording. Try another browser. The files themselves are stored safely and unchanged.'
            : unplayable[0] === 'original'
              ? 'This browser can’t play the original tape file (it is an older kind of MP3, which many browsers don’t support). The cleaned version is playing instead. The original is stored unchanged.'
              : 'This browser can’t play the cleaned version. The original tape is playing instead.'}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <div>
          <div className="mb-1 text-xs font-semibold text-faint">Original tape</div>
          <Waveform
            peaks={originalPeaks}
            duration={length}
            time={time}
            label="Original tape"
            tone="muted"
            onSeek={(s) => seek(s, false)}
          />
        </div>
        {cleanedUrl ? (
          <div>
            <div className="mb-1 text-xs font-semibold text-spruce">Cleaned</div>
            <Waveform
              peaks={cleanedPeaks}
              duration={length}
              time={time}
              label="Cleaned"
              tone="spruce"
              onSeek={(s) => seek(s, false)}
            />
          </div>
        ) : null}
      </div>

      <audio
        ref={audioRef}
        key={src}
        src={src}
        preload="metadata"
        onError={() => failed(source)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (Number.isFinite(el.duration)) setLength(Math.round(el.duration));
          el.playbackRate = speed;
          const pending = resume.current;
          if (!pending) return;
          resume.current = null;
          el.currentTime = pending.time;
          if (pending.play) void el.play();
        }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
      />

      <div className="mt-[18px] flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play'}
          className="flex size-[52px] items-center justify-center rounded-full bg-spruce text-white"
        >
          {playing ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={() => skip(-15)}
          aria-label="Back 15 seconds"
          className={transport}
        >
          −15
        </button>
        <button
          type="button"
          onClick={() => skip(15)}
          aria-label="Forward 15 seconds"
          className={transport}
        >
          +15
        </button>
        <div className="ml-1.5 font-mono text-sm" aria-live="off">
          <span className="font-medium">{formatClock(time)}</span>
          <span className="text-faint"> / {formatClock(length)}</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={cycleSpeed}
          aria-label={`Playback speed ${speed} times. Change speed`}
          className="h-11 rounded-xl border border-line-strong bg-surface px-3.5 text-sm font-semibold"
        >
          {speed}×
        </button>
      </div>
    </section>
  );
}
