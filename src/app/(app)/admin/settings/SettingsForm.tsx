'use client';

import { useActionState } from 'react';
import { MAX_RECOGNITION_WORDS, type AppSettings } from '@/lib/settings';
import { saveSettings, type SettingsFormState } from './actions';

function Field({
  id,
  label,
  hint,
  error,
  defaultValue,
  multiline = false,
}: {
  id: keyof AppSettings;
  label: string;
  hint: string;
  error?: string;
  defaultValue: string;
  multiline?: boolean;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const control = {
    id,
    name: id,
    defaultValue,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${hintId} ${errorId}` : hintId,
  };
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold">
        {label}
      </label>
      {multiline ? (
        <textarea
          {...control}
          rows={6}
          className="box-border w-full rounded-[10px] border border-line-strong bg-surface px-3.5 py-2.5 text-[15px] leading-relaxed text-ink"
        />
      ) : (
        <input
          {...control}
          className="box-border h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink"
        />
      )}
      <p id={hintId} className="mt-1.5 text-[13px] text-muted">
        {hint}
      </p>
      {error ? (
        <p id={errorId} className="mt-1 text-[13px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SettingsForm({ initial }: { initial: AppSettings }) {
  const [state, formAction, pending] = useActionState<SettingsFormState, FormData>(saveSettings, {
    status: 'idle',
    values: initial,
  });

  return (
    <form
      action={formAction}
      className="flex max-w-[560px] flex-col gap-5 rounded-2xl border border-line bg-surface px-6 py-[22px]"
    >
      <h2 className="m-0 text-[17px] font-semibold">Church profile</h2>
      <Field
        id="churchName"
        label="Church name"
        hint="Shown in the sidebar."
        error={state.errors?.churchName}
        defaultValue={state.values.churchName}
      />
      <Field
        id="defaultSpeaker"
        label="Default speaker"
        hint="Suggested as the speaker when you upload tapes. Each sermon can have a different speaker."
        error={state.errors?.defaultSpeaker}
        defaultValue={state.values.defaultSpeaker}
      />
      <Field
        id="recognitionWords"
        label="Words to recognize"
        hint={`One per line: names, places or words the transcription keeps getting wrong, spelled the way you want them. Up to ${MAX_RECOGNITION_WORDS}. Used for tapes transcribed after you save.`}
        error={state.errors?.recognitionWords}
        defaultValue={state.values.recognitionWords}
        multiline
      />
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <p role="status" className="m-0 text-[13px] font-semibold text-spruce">
          {state.status === 'saved' ? 'Saved.' : ''}
        </p>
      </div>
    </form>
  );
}
