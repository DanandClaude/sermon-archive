'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { formatClock, parseClock } from '@/lib/format';
import { CANON, findBook } from '@/lib/scripture/canon';
import { addPassageAction, editPassageAction } from './actions';
import { usePlayback, useReview } from './ReviewContext';
import type { ScriptureItem } from '@/lib/sermons/detail';

const input =
  'box-border h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-[14.5px] text-ink';
const label = 'mb-1.5 block text-[13px] font-semibold';

type Form = {
  book: string;
  chapter: string;
  verseStart: string;
  verseEnd: string;
  time: string;
  note: string;
  isMainText: boolean;
};

const blank = (at: number): Form => ({
  book: '',
  chapter: '',
  verseStart: '',
  verseEnd: '',
  time: formatClock(at),
  note: '',
  isMainText: false,
});

const fromItem = (item: ScriptureItem): Form => ({
  book: item.ref.book,
  chapter: String(item.ref.chapter),
  verseStart: item.ref.verseStart === null ? '' : String(item.ref.verseStart),
  verseEnd: item.ref.verseEnd === null ? '' : String(item.ref.verseEnd),
  time: formatClock(item.spokenAtSec),
  note: item.contextNote ?? '',
  isMainText: item.isMainText,
});

const wholeNumber = (text: string): number | null | undefined => {
  if (text.trim() === '') return null;
  return /^\d+$/.test(text.trim()) ? Number(text) : undefined;
};

/**
 * Adds a passage the system missed, or corrects one it found. `item` is the passage being
 * edited, or null to add a new one. The server checks everything again.
 */
export function PassageDialog({
  item,
  open,
  onClose,
}: {
  item: ScriptureItem | null;
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { sermonId } = useReview();
  const { currentTime } = usePlayback();
  const [form, setForm] = useState<Form>(blank(0));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      setForm(item ? fromItem(item) : blank(currentTime()));
      setErrors({});
      setMessage(null);
      el.showModal();
    }
    if (!open && el.open) el.close();
  }, [open, item, currentTime]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const book = findBook(form.book);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const seconds = parseClock(form.time);
    if (seconds === null) found.spokenAtSec = 'Write the time like 20:58 or 1:02:05.';
    const chapter = wholeNumber(form.chapter);
    const verseStart = wholeNumber(form.verseStart);
    const verseEnd = wholeNumber(form.verseEnd);
    if (chapter === null || chapter === undefined) found.chapter = 'Enter a chapter number.';
    if (verseStart === undefined) found.verseStart = 'Enter a whole number.';
    if (verseEnd === undefined) found.verseEnd = 'Enter a whole number.';
    if (!form.book) found.book = 'Choose a book.';
    if (Object.keys(found).length) {
      setErrors(found);
      setMessage('Check the highlighted fields.');
      return;
    }
    const body = {
      book: form.book,
      chapter,
      verseStart,
      verseEnd,
      spokenAtSec: seconds,
      contextNote: form.note.trim() || null,
      isMainText: form.isMainText,
    };
    start(async () => {
      const result = item
        ? await editPassageAction(sermonId, item.id, body)
        : await addPassageAction(sermonId, body);
      if (result.ok) return onClose();
      setErrors(result.fieldErrors ?? {});
      setMessage(result.error);
    });
  }

  const err = (field: string) =>
    errors[field] ? (
      <p id={`p-${field}-error`} className="mb-0 mt-1 text-[12.5px] font-semibold text-danger">
        {errors[field]}
      </p>
    ) : null;
  const invalid = (field: string) =>
    errors[field] ? { 'aria-invalid': true, 'aria-describedby': `p-${field}-error` } : {};

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="passage-title"
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-2xl border border-line bg-surface p-0 text-ink backdrop:bg-ink/40"
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4 p-6">
        <h2 id="passage-title" className="m-0 font-heading text-[24px] font-semibold">
          {item ? 'Edit passage' : 'Add a passage'}
        </h2>

        <div>
          <label htmlFor="p-book" className={label}>
            Book
          </label>
          <select
            id="p-book"
            value={form.book}
            onChange={(e) => set('book', e.target.value)}
            className={input}
            {...invalid('book')}
          >
            <option value="">Choose a book</option>
            {CANON.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          {err('book')}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label htmlFor="p-chapter" className={label}>
              Chapter
            </label>
            <input
              id="p-chapter"
              inputMode="numeric"
              value={form.chapter}
              onChange={(e) => set('chapter', e.target.value)}
              className={input}
              placeholder={book ? `1–${book.chapters.length}` : ''}
              {...invalid('chapter')}
            />
            {err('chapter')}
          </div>
          <div>
            <label htmlFor="p-vs" className={label}>
              From verse
            </label>
            <input
              id="p-vs"
              inputMode="numeric"
              value={form.verseStart}
              onChange={(e) => set('verseStart', e.target.value)}
              className={input}
              placeholder="Optional"
              {...invalid('verseStart')}
            />
            {err('verseStart')}
          </div>
          <div>
            <label htmlFor="p-ve" className={label}>
              To verse
            </label>
            <input
              id="p-ve"
              inputMode="numeric"
              value={form.verseEnd}
              onChange={(e) => set('verseEnd', e.target.value)}
              className={input}
              placeholder="Optional"
              {...invalid('verseEnd')}
            />
            {err('verseEnd')}
          </div>
        </div>
        <p className="m-0 -mt-2 text-[12.5px] text-muted">
          Leave the verses empty for a whole chapter.
        </p>

        <div>
          <label htmlFor="p-time" className={label}>
            Spoken at
          </label>
          <div className="flex gap-2">
            <input
              id="p-time"
              value={form.time}
              onChange={(e) => set('time', e.target.value)}
              className={`${input} font-mono`}
              {...invalid('spokenAtSec')}
            />
            <button
              type="button"
              onClick={() => set('time', formatClock(currentTime()))}
              className="h-11 flex-none whitespace-nowrap rounded-[10px] border border-line-strong bg-surface px-3.5 text-[13.5px] font-semibold text-spruce"
            >
              Use current playback time
            </button>
          </div>
          {err('spokenAtSec')}
        </div>

        <div>
          <label htmlFor="p-note" className={label}>
            Note <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="p-note"
            value={form.note}
            onChange={(e) => set('note', e.target.value)}
            maxLength={200}
            className={input}
            placeholder="What the pastor says here"
            {...invalid('contextNote')}
          />
          {err('contextNote')}
        </div>

        <label className="flex min-h-11 items-center gap-3 text-[14.5px]">
          <input
            type="checkbox"
            checked={form.isMainText}
            onChange={(e) => set('isMainText', e.target.checked)}
            className="size-5 accent-spruce"
          />
          This is the main text of the sermon
        </label>

        {message ? (
          <p role="alert" className="m-0 text-[13.5px] font-semibold text-danger">
            {message}
          </p>
        ) : null}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-xl border border-line-strong bg-surface px-[18px] text-[14.5px] font-semibold"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-11 rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white disabled:opacity-60"
          >
            {pending ? 'Saving…' : item ? 'Save passage' : 'Add passage'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
