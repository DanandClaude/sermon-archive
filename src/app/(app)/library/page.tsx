import Link from 'next/link';
import { Icon } from '@/components/icons';
import { PageHeader } from '@/components/shell/PageHeader';
import { StatusChip } from '@/components/StatusChip';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { formatRecordedOn } from '@/lib/format';
import { can } from '@/lib/permissions';
import { LIBRARY_TABS, listLibrary, PAGE_SIZE, type LibraryTab } from '@/lib/sermons/library';

export const metadata = { title: 'Library' };

const TAB_LABEL: Record<LibraryTab, string> = {
  all: 'All',
  in_progress: 'In progress',
  needs_review: 'Needs review',
  approved: 'Approved',
};

function href(params: { q?: string; tab?: LibraryTab; page?: number }) {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.tab && params.tab !== 'all') search.set('tab', params.tab);
  if (params.page && params.page > 1) search.set('page', String(params.page));
  const text = search.toString();
  return text ? `/library?${text}` : '/library';
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string; page?: string }>;
}) {
  const user = await requireCapability('library.browse');
  const sp = await searchParams;
  const q = (sp.q ?? '').slice(0, 100);
  const tab = (LIBRARY_TABS as readonly string[]).includes(sp.tab ?? '')
    ? (sp.tab as LibraryTab)
    : 'all';
  const result = await listLibrary(getDb(), user, { q, tab, page: Number(sp.page) });
  const canUpload = can(user.role, 'sermon.upload');
  // Viewers only ever see approved sermons, so status tabs would all read zero.
  const showTabs = user.role !== 'viewer';
  const first = result.total === 0 ? 0 : (result.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(result.page * PAGE_SIZE, result.total);

  return (
    <>
      <PageHeader
        title="Sermon library"
        description="Approved sermons are filed in the shared drive and backed up automatically."
        aside={
          canUpload ? (
            <Link
              href="/upload"
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white"
            >
              <Icon name="upload" size={18} />
              Upload tapes
            </Link>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <form role="search" action="/library" className="flex flex-wrap items-center gap-2">
          {tab !== 'all' ? <input type="hidden" name="tab" value={tab} /> : null}
          <label htmlFor="library-search" className="sr-only">
            Search the library
          </label>
          <input
            id="library-search"
            name="q"
            defaultValue={q}
            type="search"
            placeholder="Search titles, files, scripture, people"
            className="box-border h-11 w-[340px] max-w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[14.5px]"
          />
          <button
            type="submit"
            className="inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-4 text-[14px] font-semibold"
          >
            Search
          </button>
          {q ? (
            <Link
              href={href({ tab })}
              className="inline-flex h-11 items-center px-2 text-[14px] font-semibold text-spruce"
            >
              Clear
            </Link>
          ) : null}
        </form>

        {showTabs ? (
          <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            {LIBRARY_TABS.map((t) => (
              <Link
                key={t}
                href={href({ q, tab: t })}
                aria-current={t === tab ? 'page' : undefined}
                className={`inline-flex h-11 items-center gap-2 rounded-full px-4 text-[14px] font-semibold ${
                  t === tab ? 'bg-ink text-white' : 'border border-line-strong bg-surface text-ink'
                }`}
              >
                {TAB_LABEL[t]}
                <span className={t === tab ? 'text-white/80' : 'text-muted'}>
                  {result.counts[t]}
                </span>
              </Link>
            ))}
          </nav>
        ) : null}
      </div>

      <section
        aria-label="Sermons"
        className="overflow-hidden rounded-2xl border border-line bg-surface"
      >
        {result.rows.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="m-0 text-[16px] font-semibold">
              {q || tab !== 'all' ? 'No sermons match.' : 'No sermons yet.'}
            </p>
            <p className="mx-auto mb-0 mt-2 max-w-[420px] text-[14px] text-muted">
              {q || tab !== 'all'
                ? 'Try a different search or status.'
                : user.role === 'viewer'
                  ? 'Approved sermons will appear here once they are filed.'
                  : canUpload
                    ? 'Upload a tape and it will show up here as it is processed.'
                    : 'Approved sermons will appear here.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[14px]">
              <caption className="sr-only">Sermons, newest recording first</caption>
              <thead>
                <tr className="border-b border-chip text-[12.5px] uppercase tracking-[0.06em] text-muted">
                  <th scope="col" className="px-6 py-3.5 font-semibold">
                    Sermon
                  </th>
                  <th scope="col" className="px-3 py-3.5 font-semibold">
                    Scripture
                  </th>
                  <th scope="col" className="px-3 py-3.5 font-semibold">
                    Recorded
                  </th>
                  <th scope="col" className="px-3 py-3.5 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-6 py-3.5 font-semibold">
                    Uploaded by
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => {
                  const recorded = formatRecordedOn(row.recordedOn);
                  const detail = [row.side ? `Side ${row.side}` : null, row.batchLabel]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <tr key={row.id} className="border-b border-chip last:border-b-0">
                      <td className="max-w-[360px] px-6 py-4 align-top">
                        {row.title ? (
                          <div className="font-semibold">{row.title}</div>
                        ) : (
                          <div className="break-all font-mono text-[13px] font-medium">
                            {row.filename ?? 'Untitled tape'}
                          </div>
                        )}
                        {detail ? (
                          <div className="mt-0.5 text-[13px] text-muted">{detail}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-4 align-top">
                        {row.labelScripture ?? <span className="text-faint">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 align-top">
                        {recorded ?? (
                          <span className="font-semibold text-amber-text">Date needed</span>
                        )}
                      </td>
                      <td className="px-3 py-4 align-top">
                        <StatusChip status={row.status} />
                      </td>
                      <td className="px-6 py-4 align-top text-muted">{row.contributorName}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {result.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-chip bg-paper px-6 py-3 text-[13px] text-muted">
            <span>
              Showing {first}–{last} of {result.total}
            </span>
            <nav aria-label="Pages" className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={href({ q, tab, page: result.page - 1 })}
                  className="inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-4 font-semibold text-ink"
                >
                  Previous
                </Link>
              ) : null}
              {result.page < result.pageCount ? (
                <Link
                  href={href({ q, tab, page: result.page + 1 })}
                  className="inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-4 font-semibold text-ink"
                >
                  Next
                </Link>
              ) : null}
            </nav>
          </div>
        ) : null}
      </section>
    </>
  );
}
