'use client';

import {
  memo,
  useCallback,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';
import { formatClock } from '@/lib/format';
import type { Segment } from '@/lib/transcripts/render';
import { editTranscriptLineAction } from './actions';
import { usePlayback, useReview, useTime } from './ReviewContext';

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
  version,
  canEdit = false,
}: {
  segments: Segment[];
  lowConfidence: [number, number][];
  /** The transcript version shown, so an edit can't overwrite someone else's newer one. */
  version?: number;
  canEdit?: boolean;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const stopEditing = useCallback(() => setEditing(null), []);
  const { seek } = usePlayback();
  const time = useTime();
  const active = segmentAt(segments, time);
  const bodyId = useId();
  const doubtful = useMemo(() => {
    const bySegment = new Map<number, Set<number>>();
    for (const [i, j] of lowConfidence) {
      (bySegment.get(i) ?? bySegment.set(i, new Set()).get(i)!).add(j);
    }
    return bySegment;
  }, [lowConfidence]);
  const jump = useCallback((seconds: number) => seek(seconds), [seek]);
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
          {canEdit ? ' To fix a misheard word, choose Edit on its line.' : ''}
        </p>
        {open ? (
          <ol className="m-0 mt-3 list-none p-0">
            {segments.map((segment, i) => (
              <SegmentRow
                key={i}
                segment={segment}
                active={active === i}
                doubtful={doubtful.get(i) ?? null}
                onSeek={jump}
                index={i}
                editing={editing === i}
                onEdit={canEdit && version ? setEditing : null}
                onDone={stopEditing}
                version={version ?? 0}
              />
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One line of the transcript. It only re-renders when it becomes or stops being the line being
 * played, so the playback tick touches two rows, not thousands of words.
 */
const SegmentRow = memo(function SegmentRow({
  segment,
  active,
  doubtful,
  onSeek,
  index,
  editing,
  onEdit,
  onDone,
  version,
}: {
  segment: Segment;
  active: boolean;
  doubtful: Set<number> | null;
  onSeek: (seconds: number) => void;
  index: number;
  editing: boolean;
  onEdit: ((index: number) => void) | null;
  onDone: () => void;
  version: number;
}) {
  return (
    <li
      aria-current={active ? 'true' : undefined}
      className={`flex gap-4 rounded-xl px-3 py-2.5 ${active ? 'bg-spruce-mid' : ''}`}
    >
      <button
        type="button"
        onClick={() => onSeek(segment.start)}
        className="h-11 flex-none self-start rounded-lg px-2 font-mono text-[13px] font-medium text-spruce"
      >
        {formatClock(segment.start)}
        <span className="sr-only"> Play from here</span>
      </button>
      {editing ? (
        <LineEditor segment={segment} index={index} version={version} onDone={onDone} />
      ) : (
        <>
          <p className="m-0 min-w-0 flex-1 self-center text-[15px] leading-[1.6]">
            {segment.words.length > 0 && doubtful ? words(segment, doubtful) : segment.text}
          </p>
          {onEdit ? (
            <button
              type="button"
              onClick={() => onEdit(index)}
              aria-label={`Edit the line at ${formatClock(segment.start)}`}
              className="h-11 flex-none self-start rounded-lg px-2 text-[13px] font-semibold text-spruce"
            >
              Edit
            </button>
          ) : null}
        </>
      )}
    </li>
  );
});

/** Corrects one line. Saving makes a new transcript version; the old one is kept. */
function LineEditor({
  segment,
  index,
  version,
  onDone,
}: {
  segment: Segment;
  index: number;
  version: number;
  onDone: () => void;
}) {
  const { sermonId } = useReview();
  const [text, setText] = useState(segment.text.trim());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fieldId = useId();
  const save = () =>
    start(async () => {
      const result = await editTranscriptLineAction(sermonId, { version, index, text });
      if (result.ok) onDone();
      else setError(result.error);
    });
  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label htmlFor={fieldId} className="sr-only">
        Line at {formatClock(segment.start)}
      </label>
      <textarea
        id={fieldId}
        autoFocus
        rows={3}
        value={text}
        aria-invalid={!!error}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone();
        }}
        className="w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-[15px] leading-[1.6] text-ink aria-[invalid=true]:border-danger"
      />
      {error ? (
        <p role="alert" className="m-0 text-[13px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="h-11 rounded-xl bg-spruce px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="h-11 px-3 text-sm font-semibold text-spruce"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Plain text, with only the words the transcriber doubted marked up, to keep the page light. */
function words(segment: Segment, doubtful: Set<number>) {
  const pieces: React.ReactNode[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) pieces.push(run.join(' '));
    run = [];
  };
  segment.words.forEach((word, j) => {
    if (!doubtful.has(j)) return void run.push(word.w);
    flush();
    pieces.push(
      <span
        key={j}
        title="The transcriber wasn’t sure of this word"
        className="underline decoration-amber-underline decoration-dotted decoration-2 underline-offset-4"
      >
        {word.w}
      </span>,
    );
  });
  flush();
  // Put back the spaces between text and marked words.
  return pieces.flatMap((piece, i) => (i === 0 ? [piece] : [' ', piece]));
}
