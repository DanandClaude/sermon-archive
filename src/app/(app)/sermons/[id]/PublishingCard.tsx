'use client';

import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import { PublicationActions } from '@/app/(app)/admin/publishing/PublicationActions';
import { publishAction } from '@/app/(app)/admin/publishing/actions';
import { PublicationChip } from '@/components/PublicationChip';
import { lockedPrivateNote } from '@/lib/distribution/labels';
import type { PublishPreview } from '@/lib/distribution/publications';
import { CHANNEL_LABEL, type ChannelKind, type Visibility } from '@/lib/distribution/states';

const VISIBILITY_TEXT: Record<Visibility, { label: string; hint: string }> = {
  private: { label: 'Private', hint: 'Only you, signed in to the channel' },
  unlisted: { label: 'Unlisted', hint: 'Anyone with the link; not searchable' },
  public: { label: 'Public', hint: 'Anyone; shows up in search' },
};

const primary =
  'inline-flex h-11 items-center justify-center rounded-xl bg-spruce px-[18px] text-sm font-semibold text-white disabled:opacity-60';

/** Can a new publish go to this channel? Not while one is live or on its way. */
const open = (c: PublishPreview['channels'][number]) =>
  c.connected && (!c.publication || ['failed', 'removed'].includes(c.publication.state));

/** The four lines the worker draws on the video's still frame, sized as fractions of its width. */
function CoverPreview({ cover }: { cover: PublishPreview['cover'] }) {
  return (
    <div className="@container w-full">
      <div
        role="img"
        aria-label={`Video cover: ${[cover.title, cover.passage, cover.date].filter(Boolean).join(', ')}`}
        className="relative flex aspect-video w-full flex-col justify-center overflow-hidden rounded-xl bg-sidebar pl-[8%] pr-[7%]"
      >
        <span className="absolute inset-y-0 left-0 w-[0.8%] bg-amber" />
        <span className="absolute left-[8%] top-[11.5%] text-[2.05cqw] font-semibold uppercase text-sidebar-muted">
          {cover.church}
        </span>
        <span className="line-clamp-3 font-heading text-[6cqw] font-semibold leading-[1.12] text-ground">
          {cover.title}
        </span>
        {cover.passage ? (
          <span className="mt-[2.6cqw] text-[3cqw] font-semibold text-amber">{cover.passage}</span>
        ) : null}
        {cover.date ? <span className="text-[2.35cqw] text-sidebar-body">{cover.date}</span> : null}
      </div>
    </div>
  );
}

function PublishDialog({ preview, onClose }: { preview: PublishPreview; onClose: () => void }) {
  const youtube = preview.channels.find((c) => c.kind === 'youtube')!;
  const podcast = preview.channels.find((c) => c.kind === 'podcast')!;
  const [chosen, setChosen] = useState<Record<ChannelKind, boolean>>({
    youtube: open(youtube),
    podcast: false,
  });
  const [visibility, setVisibility] = useState<Visibility>(
    youtube.publication?.visibility ?? youtube.defaultVisibility,
  );
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const republish = youtube.publication?.state === 'removed';

  const needsConfirm = chosen.podcast && preview.firstPodcastEpisode && !confirmPublic;
  const nothing = !chosen.youtube && !chosen.podcast;

  function publish() {
    setErrors([]);
    start(async () => {
      const failures: string[] = [];
      for (const kind of ['youtube', 'podcast'] as const) {
        if (!chosen[kind]) continue;
        const result = await publishAction(preview.sermonId, {
          channel: kind,
          visibility: kind === 'youtube' ? visibility : 'public',
          confirmPublic: kind === 'podcast' ? confirmPublic : undefined,
        });
        if (result.ok) setChosen((c) => ({ ...c, [kind]: false }));
        else failures.push(`${CHANNEL_LABEL[kind]}: ${result.error}`);
      }
      setErrors(failures);
      if (failures.length === 0) onClose();
    });
  }

  return (
    <div className="mt-3 flex flex-col gap-4 rounded-xl border border-line-strong bg-paper p-4">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-[13px] font-semibold">Where to</legend>
        {[youtube, podcast].map((c) => (
          <label
            key={c.kind}
            className={`flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface px-3.5 text-sm ${open(c) ? '' : 'opacity-60'}`}
          >
            <input
              type="checkbox"
              className="size-[18px] accent-spruce"
              checked={chosen[c.kind]}
              disabled={!open(c) || pending}
              onChange={(e) => setChosen((s) => ({ ...s, [c.kind]: e.target.checked }))}
            />
            <span className="flex-1 font-semibold">{CHANNEL_LABEL[c.kind]}</span>
            <span className="text-[12.5px] text-muted">
              {!c.connected
                ? 'Not connected'
                : c.publication && !open(c)
                  ? 'Already there'
                  : c.kind === 'podcast'
                    ? 'Public'
                    : ''}
            </span>
          </label>
        ))}
      </fieldset>

      {chosen.youtube ? (
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 text-[13px] font-semibold">Who can watch on YouTube</legend>
          <div className="grid gap-2">
            {(['private', 'unlisted', 'public'] as const).map((v) => (
              <label
                key={v}
                className={`flex min-h-11 cursor-pointer flex-col justify-center rounded-xl border px-3 py-2 text-sm ${visibility === v ? 'border-spruce bg-spruce-mid' : 'border-line bg-surface'}`}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <input
                    type="radio"
                    name="visibility"
                    value={v}
                    checked={visibility === v}
                    onChange={() => setVisibility(v)}
                    className="accent-spruce"
                  />
                  {VISIBILITY_TEXT[v].label}
                </span>
                <span className="text-xs text-muted">{VISIBILITY_TEXT[v].hint}</span>
              </label>
            ))}
          </div>
          {republish ? (
            <p className="mb-0 mt-2 text-[13px] text-muted">
              This video is still on YouTube as a private video. Publishing again changes who can
              watch it; the title and description stay as they were.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {chosen.youtube && !republish ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-[13px] font-semibold">What YouTube gets</h3>
          <CoverPreview cover={preview.cover} />
          <p className="m-0 text-[15px] font-semibold">{preview.youtube.title}</p>
          <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-surface p-3 font-sans text-[13px] leading-[1.5] text-ink">
            {preview.youtube.description}
          </pre>
          <p className="m-0 text-xs text-muted">Captions are added from the transcript.</p>
        </div>
      ) : null}

      {chosen.podcast ? (
        <div className="rounded-xl bg-amber-tint px-3.5 py-3 text-[13.5px] text-amber-text">
          <p className="m-0">
            Podcasts have no unlisted setting. Once this episode is in the feed, anyone with the
            feed’s link can listen to and download the recording.
          </p>
          {preview.firstPodcastEpisode ? (
            <label className="mt-2 flex min-h-11 items-center gap-2 font-semibold">
              <input
                type="checkbox"
                className="size-[18px] accent-spruce"
                checked={confirmPublic}
                onChange={(e) => setConfirmPublic(e.target.checked)}
              />
              I understand this first episode will be public.
            </label>
          ) : null}
        </div>
      ) : null}

      {errors.length ? (
        <div role="alert" className="text-[13.5px] font-semibold text-danger">
          {errors.map((e) => (
            <p key={e} className="m-0">
              {e}
            </p>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl px-4 text-sm font-semibold text-spruce"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={publish}
          disabled={pending || nothing || needsConfirm}
          className={primary}
        >
          {pending ? 'Publishing…' : 'Publish'}
        </button>
      </div>
    </div>
  );
}

/** Admins only: where this sermon is published, and the Publish dialog. */
export function PublishingCard({ preview }: { preview: PublishPreview }) {
  const [dialog, setDialog] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const anyOpen = preview.channels.some(open);
  const anyConnected = preview.channels.some((c) => c.connected);

  return (
    <section
      aria-labelledby="publishing-h"
      className="rounded-2xl border border-line bg-surface px-[22px] py-5"
    >
      <h2 id="publishing-h" className="m-0 mb-2.5 text-[17px] font-semibold">
        Publishing
      </h2>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {preview.channels.map((c) => {
          const note = c.publication ? lockedPrivateNote(c.publication) : null;
          return (
            <li key={c.kind} className="border-t border-chip pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-semibold">{CHANNEL_LABEL[c.kind]}</span>
                {c.publication ? (
                  <PublicationChip {...c.publication} />
                ) : (
                  <span className="text-[13px] text-muted">
                    {c.connected ? 'Not published' : 'Not connected'}
                  </span>
                )}
              </div>
              {c.publication?.lastError ? (
                <p role="alert" className="mb-0 mt-1.5 text-[13px] font-semibold text-danger">
                  {c.publication.lastError}
                </p>
              ) : null}
              {note ? <p className="mb-0 mt-1.5 text-[13px] text-amber-text">{note}</p> : null}
              {c.publication?.remoteUrl && c.publication.state !== 'removed' ? (
                <a
                  href={c.publication.remoteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 inline-block text-[13px] font-semibold text-spruce"
                >
                  Open on YouTube
                </a>
              ) : null}
              {c.publication ? (
                <div className="mt-2">
                  <PublicationActions
                    id={c.publication.id}
                    state={c.publication.state}
                    channel={c.kind}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {preview.missingAudio ? (
        <p className="mb-0 mt-3 text-[13px] text-muted">
          This sermon has no cleaned recording, so it can’t be published.
        </p>
      ) : !anyConnected ? (
        <p className="mb-0 mt-3 text-[13px] text-muted">
          Connect YouTube or the podcast feed on the{' '}
          <Link href="/admin/connections" className="font-semibold text-spruce">
            Connections page
          </Link>{' '}
          to publish.
        </p>
      ) : dialog ? (
        <PublishDialog
          preview={preview}
          onClose={() => {
            setDialog(false);
            button.current?.focus();
          }}
        />
      ) : anyOpen ? (
        <button
          ref={button}
          type="button"
          onClick={() => setDialog(true)}
          className={`${primary} mt-3`}
        >
          Publish…
        </button>
      ) : null}
    </section>
  );
}
