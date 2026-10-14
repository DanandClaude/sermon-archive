import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { getLibraryInfo, libraryEntryPath, listLibrary } from '@/lib/distribution/library';
import { formatClock, formatRecordedOn } from '@/lib/format';

export async function generateMetadata(): Promise<Metadata> {
  const info = await getLibraryInfo(getDb());
  return info
    ? { title: { absolute: info.title }, description: info.description || undefined }
    : { title: 'Not found' };
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').slice(0, 100);
  const library = await listLibrary(getDb(), query);
  if (!library) notFound();
  const { info, entries, total } = library;

  return (
    <>
      {info.description ? (
        <p className="m-0 max-w-[60ch] text-[15px] leading-normal text-muted">{info.description}</p>
      ) : null}
      <form role="search" action="" className="mt-5 flex gap-2">
        <label htmlFor="q" className="sr-only">
          Search sermons
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="Title, Bible book or year"
          className="h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] text-ink"
        />
        <button
          type="submit"
          className="h-11 rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white"
        >
          Search
        </button>
      </form>

      <p className="mb-3 mt-5 text-[13px] text-muted" aria-live="polite">
        {query
          ? `${entries.length} of ${total} ${total === 1 ? 'sermon' : 'sermons'} match “${query}”.`
          : `${total} ${total === 1 ? 'sermon' : 'sermons'}`}
        {query ? (
          <>
            {' '}
            <Link href="?" className="font-semibold text-spruce">
              Show all
            </Link>
          </>
        ) : null}
      </p>

      {total === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-6 text-[15px]">
          No sermons have been added yet. Check back soon.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {entries.map((e) => (
            <li key={e.id}>
              <Link
                href={libraryEntryPath(e.id)}
                className="block rounded-2xl border border-line bg-surface px-5 py-4 text-ink no-underline hover:border-line-strong"
              >
                <span className="block font-heading text-[19px] font-semibold leading-[1.25]">
                  {e.title}
                </span>
                <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13.5px] text-muted">
                  {e.passage ? (
                    <span className="font-semibold text-spruce">{e.passage}</span>
                  ) : null}
                  {e.recordedOn ? <span>{formatRecordedOn(e.recordedOn)}</span> : null}
                  {e.speaker ? <span>{e.speaker}</span> : null}
                  {e.durationSec ? (
                    <span className="font-mono text-[12.5px]">{formatClock(e.durationSec)}</span>
                  ) : null}
                </span>
                {e.summary ? (
                  <span className="mt-2 line-clamp-2 block text-[14px] leading-normal">
                    {e.summary}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
