'use client';

import { useState, useTransition } from 'react';
import type { PodcastSettings } from '@/lib/distribution/feed';
import type { Visibility } from '@/lib/distribution/states';
import {
  connectTestYouTubeAction,
  disconnectChannelAction,
  savePodcastSettingsAction,
  saveYouTubeSettingsAction,
  type StorageActionResult,
} from './actions';

const secondary =
  'inline-flex h-11 items-center justify-center rounded-xl border border-line-strong bg-surface px-4 text-sm font-semibold text-ink disabled:opacity-60';
const primary =
  'inline-flex h-11 items-center justify-center rounded-xl bg-spruce px-[18px] text-sm font-semibold text-white disabled:opacity-60';
const input =
  'h-11 w-full rounded-xl border border-line-strong bg-surface px-3 text-[14.5px] text-ink aria-[invalid=true]:border-danger';

function useAction() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<StorageActionResult | null>(null);
  const run = (work: () => Promise<StorageActionResult>, after?: () => void) =>
    start(async () => {
      const outcome = await work();
      setResult(outcome);
      if (outcome.ok) after?.();
    });
  const note = result ? (
    <p
      role={result.ok ? 'status' : 'alert'}
      className={`m-0 text-[13px] font-semibold ${result.ok ? 'text-spruce' : 'text-danger'}`}
    >
      {result.ok ? result.message : result.error}
    </p>
  ) : null;
  const fieldErrors = result && !result.ok ? (result.fieldErrors ?? {}) : {};
  return { pending, run, note, fieldErrors };
}

function Disconnect({ kind, prompt, label }: { kind: string; prompt: string; label: string }) {
  const { pending, run, note } = useAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      {confirming ? (
        <div className="rounded-xl bg-amber-tint px-3.5 py-3 text-[13.5px] text-amber-text">
          <p className="m-0">{prompt}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => disconnectChannelAction(kind),
                  () => setConfirming(false),
                )
              }
              className="h-11 rounded-xl bg-danger px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              {label}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-11 px-3 text-sm font-semibold text-spruce"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="h-11 self-start px-3 text-sm font-semibold text-danger"
        >
          {label}
        </button>
      )}
      {note}
    </div>
  );
}

export function YouTubeControls({
  connected,
  realMode,
  settings,
}: {
  connected: boolean;
  realMode: boolean;
  settings: { defaultVisibility: Visibility; dailyUploads: number };
}) {
  const { pending, run, note, fieldErrors } = useAction();
  const [form, setForm] = useState(settings);

  if (!connected) {
    return (
      <div className="mt-2 flex flex-col gap-2">
        {realMode ? (
          <a href="/api/connections/google/start?role=youtube" className={`${primary} self-start`}>
            Connect YouTube
          </a>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(connectTestYouTubeAction)}
            className={`${primary} self-start`}
          >
            Use a test channel
          </button>
        )}
        <p className="m-0 text-[12.5px] leading-[1.45] text-muted">
          {realMode
            ? 'Sign in with the Google account that owns the church’s YouTube channel.'
            : 'Development mode “uploads” to a folder on this computer. Nothing goes to YouTube.'}
        </p>
        {note}
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-3">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => saveYouTubeSettingsAction(form));
        }}
      >
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
          Start new videos as
          <select
            className={input}
            value={form.defaultVisibility}
            onChange={(e) => setForm({ ...form, defaultVisibility: e.target.value as Visibility })}
          >
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
          Uploads a day, at most
          <input
            type="number"
            min={1}
            max={50}
            className={input}
            value={form.dailyUploads}
            aria-invalid={!!fieldErrors.dailyUploads}
            onChange={(e) => setForm({ ...form, dailyUploads: Number(e.target.value) })}
          />
          {fieldErrors.dailyUploads ? (
            <span className="font-normal text-danger">{fieldErrors.dailyUploads}</span>
          ) : null}
        </label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" disabled={pending} className={secondary}>
            Save
          </button>
          {note}
        </div>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {realMode ? (
          <a href="/api/connections/google/start?role=youtube" className={secondary}>
            Reconnect account
          </a>
        ) : null}
        <Disconnect
          kind="youtube"
          label="Disconnect"
          prompt="Disconnect YouTube? Videos already there stay as they are. Nothing new can be published until it is connected again."
        />
      </div>
    </div>
  );
}

const FIELDS: { key: keyof PodcastSettings; label: string; hint?: string; long?: boolean }[] = [
  { key: 'title', label: 'Podcast name' },
  { key: 'author', label: 'By', hint: 'The church or the pastor, as listeners will see it.' },
  { key: 'description', label: 'Description', long: true },
  {
    key: 'ownerEmail',
    label: 'Owner email',
    hint: 'Apple and Spotify send a code here to confirm the podcast is yours. It appears in the feed.',
  },
  { key: 'language', label: 'Language', hint: 'A code such as en-us.' },
];

export function PodcastControls({
  connected,
  settings,
}: {
  connected: boolean;
  settings: PodcastSettings;
}) {
  const { pending, run, note, fieldErrors } = useAction();
  const [form, setForm] = useState(settings);
  return (
    <div className="mt-2 flex flex-col gap-3">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => savePodcastSettingsAction(form));
        }}
      >
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1.5 text-[13px] font-semibold">
            {f.label}
            {f.long ? (
              <textarea
                rows={3}
                className={`${input} h-auto py-2.5`}
                value={form[f.key]}
                aria-invalid={!!fieldErrors[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            ) : (
              <input
                type={f.key === 'ownerEmail' ? 'email' : 'text'}
                className={input}
                value={form[f.key]}
                aria-invalid={!!fieldErrors[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            )}
            {fieldErrors[f.key] ? (
              <span className="font-normal text-danger">{fieldErrors[f.key]}</span>
            ) : f.hint ? (
              <span className="font-normal text-muted">{f.hint}</span>
            ) : null}
          </label>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className={connected ? secondary : primary}>
            {connected ? 'Save' : 'Turn on the feed'}
          </button>
          {note}
        </div>
      </form>
      {connected ? (
        <Disconnect
          kind="podcast"
          label="Turn off the feed"
          prompt="Turn off the podcast feed? Podcast apps stop getting new episodes and the episode links stop working. Turning it back on restores them."
        />
      ) : null}
    </div>
  );
}

export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-lg bg-chip px-2.5 py-2 font-mono text-[12.5px]">
        {url}
      </code>
      <button
        type="button"
        className={secondary}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
