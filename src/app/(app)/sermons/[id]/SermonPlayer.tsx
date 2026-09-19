'use client';

import { useState } from 'react';
import { formatClock } from '@/lib/format';
import type { Peaks } from '@/lib/sermons/peaks';
import { usePlayback, useTime } from './ReviewContext';
import { Waveform } from './Waveform';

const SPEEDS = [1, 1.25, 1.5, 0.75];

const transport =
  'flex size-11 items-center justify-center rounded-full border border-line-strong bg-surface text-[12.5px] font-bold text-ink';

/** Plays the cleaned recording. The original tape is kept in storage but is not offered for review. */
export function SermonPlayer({
  cleanedUrl,
  cleanedPeaks,
  durationSec,
}: {
  cleanedUrl: string;
  cleanedPeaks: Peaks | null;
  durationSec: number | null;
}) {
  const { audioRef, setTime, seek } = usePlayback();
  const time = useTime();
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [length, setLength] = useState(durationSec ?? 0);
  const [broken, setBroken] = useState(false);

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

  const skip = (by: number) => seek((audioRef.current?.currentTime ?? 0) + by, false);

  return (
    <section
      aria-label="Audio player"
      className="rounded-2xl border border-line bg-surface px-6 pb-[22px] pt-5"
    >
      {broken ? (
        <p
          role="alert"
          className="mb-4 mt-0 rounded-xl bg-amber-tint px-3.5 py-3 text-[13.5px] leading-[1.5] text-amber-text"
        >
          This browser can’t play this recording. Try another browser. The file itself is stored
          safely and unchanged.
        </p>
      ) : null}

      <Waveform
        peaks={cleanedPeaks}
        duration={length}
        time={time}
        label="Recording"
        tone="spruce"
        onSeek={(s) => seek(s, false)}
      />

      <audio
        ref={audioRef}
        src={cleanedUrl}
        preload="metadata"
        onError={() => {
          setBroken(true);
          setPlaying(false);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (Number.isFinite(el.duration)) setLength(Math.round(el.duration));
          el.playbackRate = speed;
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
