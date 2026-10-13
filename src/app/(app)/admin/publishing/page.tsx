import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { PublicationChip } from '@/components/PublicationChip';
import { AdminOnlyBadge, PageHeader } from '@/components/shell/PageHeader';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { lockedPrivateNote } from '@/lib/distribution/labels';
import { listPublications, type QueueRow } from '@/lib/distribution/publications';
import { CHANNEL_LABEL } from '@/lib/distribution/states';
import { timeAgo } from '@/lib/format';
import { PublicationActions } from './PublicationActions';

export const metadata = { title: 'Publishing' };

function Row({ row }: { row: QueueRow }) {
  const note = lockedPrivateNote(row);
  return (
    <li className="flex flex-col gap-2 border-b border-chip px-6 py-4 last:border-b-0 md:flex-row md:items-start md:gap-6">
      <div className="min-w-0 flex-1">
        <Link
          href={`/sermons/${row.sermonId}`}
          className="font-semibold text-ink underline-offset-2 hover:underline"
        >
          {row.sermonTitle ?? 'Untitled sermon'}
        </Link>
        {row.stem ? (
          <span className="block break-all font-mono text-xs text-muted">{row.stem}</span>
        ) : null}
        <p className="m-0 mt-1 text-[13px] text-muted">
          {CHANNEL_LABEL[row.channel]} · asked by {row.requestedByName} {timeAgo(row.requestedAt)}
          {row.publishedAt && row.state === 'published'
            ? ` · live ${timeAgo(row.publishedAt)}`
            : ''}
          {row.waiting ? ' · waiting to try again' : ''}
        </p>
        {row.lastError ? (
          <p role="alert" className="m-0 mt-1.5 text-[13px] font-semibold text-danger">
            {row.lastError}
          </p>
        ) : null}
        {note ? <p className="m-0 mt-1.5 text-[13px] text-amber-text">{note}</p> : null}
        {row.errorDetail ? (
          <details className="mt-1.5 text-xs text-muted">
            <summary className="cursor-pointer font-semibold">Technical detail</summary>
            <span className="mt-1 block break-all font-mono">{row.errorDetail}</span>
          </details>
        ) : null}
      </div>
      <div className="flex flex-col items-start gap-2 md:w-[260px] md:flex-none md:items-end">
        <PublicationChip {...row} />
        {row.remoteUrl ? (
          <a
            href={row.remoteUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-semibold text-spruce"
          >
            Open on YouTube
          </a>
        ) : null}
        <PublicationActions id={row.id} state={row.state} channel={row.channel} />
      </div>
    </li>
  );
}

function Section({
  id,
  title,
  rows,
  empty,
}: {
  id: string;
  title: string;
  rows: QueueRow[];
  empty?: string;
}) {
  if (rows.length === 0 && !empty) return null;
  return (
    <section
      aria-labelledby={id}
      className="overflow-hidden rounded-2xl border border-line bg-surface"
    >
      <h2
        id={id}
        className="m-0 border-b border-chip px-6 pb-4 pt-[22px] text-[17px] font-semibold"
      >
        {title} <span className="font-normal text-muted">· {rows.length}</span>
      </h2>
      {rows.length ? (
        <ul className="m-0 list-none p-0">
          {rows.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </ul>
      ) : (
        <p className="m-0 px-6 py-5 text-sm text-muted">{empty}</p>
      )}
    </section>
  );
}

export default async function PublishingPage() {
  const user = await requireCapability('sermon.publish');
  const rows = await listPublications(getDb(), user);
  const active = rows.filter((r) => ['queued', 'publishing', 'removing'].includes(r.state));
  const failed = rows.filter((r) => r.state === 'failed');
  const live = rows.filter((r) => r.state === 'published');
  const removed = rows.filter((r) => r.state === 'removed');
  const busy = active.some((r) => !r.waiting);

  return (
    <>
      {busy ? <AutoRefresh everyMs={4000} /> : null}
      <PageHeader
        title="Publishing"
        description="Sermons on their way to YouTube and the podcast feed, and what’s already out. Publish a sermon from its page."
        aside={<AdminOnlyBadge />}
      />
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong bg-paper px-6 py-10 text-center text-muted">
          Nothing has been published yet. Open an approved sermon and choose Publish.
        </div>
      ) : (
        <>
          <Section id="failed-h" title="Needs attention" rows={failed} />
          <Section id="active-h" title="In progress" rows={active} />
          <Section
            id="live-h"
            title="Published"
            rows={live}
            empty="Nothing is published right now."
          />
          <Section id="removed-h" title="Unpublished" rows={removed} />
        </>
      )}
    </>
  );
}
