'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ActionResult } from './actions';

/** What the audio player shares with the passages, transcript and forms around it. */
type Playback = {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Seconds. Updated a few times a second while playing. */
  time: number;
  setTime: (seconds: number) => void;
  /** The exact position right now, for "use current playback time". */
  currentTime: () => number;
  seek: (seconds: number, play?: boolean) => void;
};

/** The unsaved state of the details form, so the header can save and approve it. */
export type Draft = {
  dirty: boolean;
  /** What still blocks approval, by field, as far as the browser can tell. */
  problems: Record<string, string>;
  /** The file name the details would give, for the approval confirmation. */
  stem: string;
  save: () => Promise<ActionResult>;
};

type Review = {
  sermonId: string;
  playback: Playback;
  draft: Draft | null;
  registerDraft: (draft: Draft | null) => void;
};

const ReviewContext = createContext<Review | null>(null);

export function ReviewProvider({ sermonId, children }: { sermonId: string; children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [time, setTime] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Stable, so a form can register itself in an effect without re-running it every render.
  const registerDraft = useCallback((next: Draft | null) => setDraft(() => next), []);

  const currentTime = useCallback(() => audioRef.current?.currentTime ?? 0, []);
  const seek = useCallback((seconds: number, play = true) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, seconds);
    setTime(Math.max(0, seconds));
    if (play) void el.play();
  }, []);

  const value = useMemo<Review>(
    () => ({
      sermonId,
      playback: { audioRef, time, setTime, currentTime, seek },
      draft,
      registerDraft,
    }),
    [sermonId, time, currentTime, seek, draft, registerDraft],
  );
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useReview(): Review {
  const value = useContext(ReviewContext);
  if (!value) throw new Error('useReview must be used inside ReviewProvider');
  return value;
}

export const usePlayback = () => useReview().playback;
