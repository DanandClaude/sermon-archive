'use client';

import { memo, useMemo } from 'react';
import { formatClock } from '@/lib/format';

import type { Peaks } from '@/lib/sermons/peaks';

const BARS = 240;

/** Squeezes the stored peaks (a couple per second) down to a fixed number of bars. */
export function downsample(peaks: number[], bars: number): number[] {
  if (peaks.length === 0) return [];
  return Array.from({ length: bars }, (_, i) => {
    const from = Math.floor((i * peaks.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / bars));
    let top = 0;
    for (let j = from; j < to && j < peaks.length; j++) top = Math.max(top, peaks[j]);
    return top;
  });
}

/**
 * The tape's loudness over time. Click or use the arrow keys to move through the recording; the
 * part already played is filled in.
 */
export function Waveform({
  peaks,
  duration,
  time,
  label,
  tone,
  onSeek,
}: {
  peaks: Peaks | null;
  duration: number;
  time: number;
  label: string;
  tone: 'muted' | 'spruce';
  onSeek: (seconds: number) => void;
}) {
  const bars = useMemo(() => downsample(peaks?.peaks ?? [], BARS), [peaks]);
  const total = duration || peaks?.duration || 0;
  const progress = total > 0 ? Math.min(1, time / total) : 0;
  const base = tone === 'spruce' ? 'var(--color-spruce-tint)' : 'var(--color-line-strong)';
  const played = tone === 'spruce' ? 'var(--color-spruce)' : 'var(--color-faint)';

  if (bars.length === 0) {
    return (
      <div className="flex h-16 items-center text-[13px] text-muted">
        The waveform appears once processing finishes.
      </div>
    );
  }

  const clip = `wave-${label.replace(/\W+/g, '')}`;
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={`${label}: position in the recording`}
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${formatClock(time)} of ${formatClock(total)}`}
      className="relative h-16 w-full cursor-pointer rounded-lg"
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        if (box.width > 0 && total > 0)
          onSeek(Math.min(total, Math.max(0, ((e.clientX - box.left) / box.width) * total)));
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 30 : 5;
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          onSeek(Math.min(total, time + step));
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onSeek(Math.max(0, time - step));
        }
        if (e.key === 'Home') {
          e.preventDefault();
          onSeek(0);
        }
        if (e.key === 'End') {
          e.preventDefault();
          onSeek(total);
        }
      }}
    >
      <svg
        viewBox={`0 0 ${BARS} 64`}
        preserveAspectRatio="none"
        className="block h-full w-full"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clip}>
            <rect x="0" y="0" width={progress * BARS} height="64" />
          </clipPath>
        </defs>
        <Bars bars={bars} fill={base} />
        <Bars bars={bars} fill={played} clipPath={`url(#${clip})`} />
      </svg>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 top-0 w-0.5 rounded-sm bg-ink"
        style={{ left: `calc(${progress * 100}% - 1px)` }}
      />
    </div>
  );
}

/** The bars themselves. They only change when the recording does, not on every playback tick. */
const Bars = memo(function Bars({
  bars,
  fill,
  clipPath,
}: {
  bars: number[];
  fill: string;
  clipPath?: string;
}) {
  return (
    <g fill={fill} clipPath={clipPath}>
      {bars.map((p, i) => {
        const h = Math.max(3, p * 60);
        return <rect key={i} x={i + 0.15} y={32 - h / 2} width={0.7} height={h} rx={0.3} />;
      })}
    </g>
  );
});
