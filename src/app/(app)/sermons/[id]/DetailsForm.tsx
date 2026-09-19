'use client';

import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { filenameStem } from '@/lib/naming-core';
import { parseLabelDate } from '@/lib/uploads/label';
import { parseReferenceText, type Reference } from '@/lib/scripture/canon';
import { saveDetailsAction, type ActionResult } from './actions';
import { useReview } from './ReviewContext';

const input =
  'box-border h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-[14.5px] text-ink';
const labelClass = 'mb-1.5 block text-[13px] font-semibold';

export type DetailsValues = {
  title: string;
  recordedOn: string;
  speaker: string;
  primaryPassage: string;
  topics: string[];
};

const same = (a: DetailsValues, b: DetailsValues) => JSON.stringify(a) === JSON.stringify(b);

/** What is wrong with the values, as far as the browser can tell. The server checks again. */
export function detailsProblems(values: DetailsValues): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!values.recordedOn.trim()) problems.recordedOn = 'Add the date from the tape label.';
  else {
    const date = parseLabelDate(values.recordedOn);
    if (!date.ok) problems.recordedOn = date.error;
  }
  if (!values.primaryPassage.trim()) problems.primaryPassage = 'Choose the main passage.';
  else {
    const passage = parseReferenceText(values.primaryPassage);
    if (!passage.ok) problems.primaryPassage = passage.error;
  }
  if (!values.title.trim()) problems.title = 'Give the sermon a short title.';
  return problems;
}

export function DetailsForm({
  initial,
  tags,
  suggestions,
  batchLabel,
  originalFilename,
  stemLocked,
}: {
  initial: DetailsValues;
  /** Testament, genre and book tags, which follow the main passage. */
  tags: string[];
  suggestions: string[];
  batchLabel: string | null;
  originalFilename: string | null;
  /** The file name was fixed when the sermon was approved. */
  stemLocked: string | null;
}) {
  const { sermonId, registerDraft } = useReview();
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [topicText, setTopicText] = useState('');
  const [pending, start] = useTransition();
  const listId = useId();

  // When the server's copy changes (a passage marked as the main text, say), take the changed
  // fields but keep whatever else is being typed.
  const lastInitial = useRef(initial);
  useEffect(() => {
    const before = lastInitial.current;
    if (same(before, initial)) return;
    lastInitial.current = initial;
    setSaved(initial);
    setValues((current) => {
      const next = { ...current };
      for (const key of Object.keys(initial) as (keyof DetailsValues)[]) {
        if (JSON.stringify(before[key]) !== JSON.stringify(initial[key]))
          (next as Record<string, unknown>)[key] = initial[key];
      }
      return next;
    });
  }, [initial]);

  const dirty = !same(values, saved);
  const problems = detailsProblems(values);
  const date = parseLabelDate(values.recordedOn);
  const passage = parseReferenceText(values.primaryPassage);
  const stem =
    stemLocked ??
    filenameStem({
      recordedOn: date.ok ? date.iso : null,
      passage: passage.ok ? (passage.ref as Reference) : null,
      title: values.title,
      batchLabel,
      originalFilename,
    });

  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  });
  const save = useCallback(async (): Promise<ActionResult> => {
    const now = latest.current;
    setMessage(null);
    const result = await saveDetailsAction(sermonId, now);
    if (result.ok) {
      setSaved(now);
      setErrors({});
    } else {
      setErrors(result.fieldErrors ?? {});
      setMessage(result.error);
    }
    return result;
  }, [sermonId]);

  const problemKey = JSON.stringify(problems);
  useEffect(() => {
    registerDraft({ dirty, problems: JSON.parse(problemKey), stem, save });
    return () => registerDraft(null);
  }, [dirty, problemKey, stem, save, registerDraft]);

  const set = <K extends keyof DetailsValues>(key: K, value: DetailsValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  function addTopic(text: string) {
    const topic = text.trim().replace(/,+$/, '').trim();
    if (!topic) return;
    if (values.topics.some((t) => t.toLowerCase() === topic.toLowerCase())) return setTopicText('');
    if (values.topics.length >= 5) return setMessage('Use up to 5 topics.');
    set('topics', [...values.topics, topic]);
    setTopicText('');
  }

  // Only show a problem once the field has something in it, or the server has complained.
  const shown = (field: string) =>
    errors[field] ?? (values[field as keyof DetailsValues] ? problems[field] : undefined);
  const err = (field: string) =>
    shown(field) ? (
      <p id={`d-${field}-error`} className="mb-0 mt-1 text-xs font-semibold text-danger">
        {shown(field)}
      </p>
    ) : null;
  const invalid = (field: string) =>
    shown(field) ? { 'aria-invalid': true, 'aria-describedby': `d-${field}-error` } : {};

  return (
    <section
      aria-labelledby="details-h"
      className="rounded-2xl border border-line bg-surface px-[22px] py-5"
    >
      <h2 id="details-h" className="m-0 mb-3.5 text-[17px] font-semibold">
        Details
      </h2>

      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[13px] font-semibold">File name</span>
        <span className="inline-flex h-[22px] items-center rounded-full bg-spruce-tint px-2 text-[11.5px] font-semibold text-spruce">
          {stemLocked ? 'Filed as' : 'Auto-named'}
        </span>
      </div>
      <div
        data-testid="file-name-preview"
        className="break-all rounded-[10px] border border-line-strong bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-[1.5]"
      >
        {stem}
      </div>
      <p className="mb-3.5 mt-1.5 text-xs text-muted">
        {stemLocked
          ? 'The file name was set when the sermon was approved.'
          : 'Pattern: YYYY-MM-DD_Book-Chapter-Verse_ShortTitle'}
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => void (await save()));
        }}
        noValidate
      >
        <label htmlFor="d-title" className={labelClass}>
          Title
        </label>
        <input
          id="d-title"
          value={values.title}
          onChange={(e) => set('title', e.target.value)}
          maxLength={80}
          className={input}
          {...invalid('title')}
        />
        {err('title')}

        <div className="mt-3.5 grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="d-date" className={labelClass}>
              Recorded
            </label>
            <input
              id="d-date"
              value={values.recordedOn}
              onChange={(e) => set('recordedOn', e.target.value)}
              placeholder="MM/DD/YYYY"
              className={input}
              {...invalid('recordedOn')}
            />
            {err('recordedOn')}
          </div>
          <div>
            <label htmlFor="d-ref" className={labelClass}>
              Main passage
            </label>
            <input
              id="d-ref"
              value={values.primaryPassage}
              onChange={(e) => set('primaryPassage', e.target.value)}
              placeholder="Hebrews 13:17"
              className={input}
              {...invalid('primaryPassage')}
            />
            {err('primaryPassage')}
          </div>
        </div>

        <div className="mt-3.5">
          <label htmlFor="d-speaker" className={labelClass}>
            Speaker
          </label>
          <input
            id="d-speaker"
            value={values.speaker}
            onChange={(e) => set('speaker', e.target.value)}
            className={input}
            {...invalid('speaker')}
          />
          {err('speaker')}
        </div>

        <div className="mb-2 mt-4 text-[13px] font-semibold">Categories</div>
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex h-[30px] items-center rounded-full bg-chip px-3 text-[13px]"
            >
              {tag}
            </span>
          ))}
          {values.topics.map((topic) => (
            <span
              key={topic}
              className="inline-flex h-[30px] items-center gap-1 rounded-full bg-spruce-tint pl-3 pr-1 text-[13px] text-spruce"
            >
              {topic}
              <button
                type="button"
                aria-label={`Remove topic ${topic}`}
                onClick={() =>
                  set(
                    'topics',
                    values.topics.filter((t) => t !== topic),
                  )
                }
                className="flex size-6 items-center justify-center rounded-full text-base leading-none"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        {tags.length === 0 ? (
          <p className="mb-0 mt-2 text-xs text-muted">
            Testament, genre and book tags appear once there is a main passage.
          </p>
        ) : null}
        <div className="mt-2.5 flex gap-2">
          <label htmlFor="d-topic" className="sr-only">
            Add a topic
          </label>
          <input
            id="d-topic"
            value={topicText}
            list={listId}
            onChange={(e) => setTopicText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTopic(topicText);
              }
            }}
            placeholder="Add a topic"
            maxLength={40}
            className={input}
          />
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={() => addTopic(topicText)}
            className="h-11 flex-none rounded-[10px] border border-dashed border-[#b9ae9a] px-3.5 text-[13px] font-semibold text-spruce"
          >
            + Add
          </button>
        </div>
        {errors.topics ? (
          <p className="mb-0 mt-1 text-xs font-semibold text-danger">{errors.topics}</p>
        ) : null}

        {message ? (
          <p role="alert" className="mb-0 mt-3.5 text-[13.5px] font-semibold text-danger">
            {message}
          </p>
        ) : null}
        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={!dirty || pending}
            className="inline-flex h-11 items-center rounded-xl bg-spruce px-[18px] text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save details'}
          </button>
          <span aria-live="polite" className="text-[13px] text-muted">
            {dirty ? 'Unsaved changes' : 'Saved'}
          </span>
        </div>
      </form>
    </section>
  );
}
