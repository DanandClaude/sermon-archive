import Link from 'next/link';
import { Icon } from '@/components/icons';
import { PageHeader } from '@/components/shell/PageHeader';
import { StatusChip } from '@/components/StatusChip';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { formatRecordedOn } from '@/lib/format';
import { can } from '@/lib/permissions';
import {
  libraryFilterOptions,
  LIBRARY_TABS,
  listLibrary,
  PAGE_SIZE,
  parseFilters,
  type LibraryFilters,
  type LibraryTab,
} from '@/lib/sermons/library';
import { LibraryGrid } from './LibraryGrid';
import { TranscriptSnippet } from './TranscriptSnippet';

export const metadata = { title: 'Library' };

const TAB_LABEL: Record<LibraryTab, string> = {
  all: 'All',
  in_progress: 'In progress',
  needs_review: 'Needs review',
  approved: 'Approved',
};

type View = 'list' | 'grid';
type State = { q?: string; tab?: LibraryTab; page?: number; view?: View } & LibraryFilters;

const CATEGORY_GROUPS = [
  ['testament', 'Testament'],
  ['genre', 'Kind of book'],
  ['topic', 'Topic'],
] as const;

const SELECT =
  'box-border h-11 max-w-full rounded-[10px] border border-line-strong bg-surface px-3 text-[14px]';

function href(params: State) {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.book) search.set('book', params.book);
  if (params.category) search.set('category', params.category);
  if (params.decade) search.set('decade', String(params.decade));
  if (params.contributor) search.set('contributor', params.contributor);
  if (params.tab && params.tab !== 'all') search.set('tab', params.tab);
  if (params.view === 'grid') search.set('view', 'grid');
  if (params.page && params.page > 1) search.set('page', String(params.page));
  const text = search.toString();
  return text ? `/library?${text}` : '/library';
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireCapability('library.browse');
  const sp = await searchParams;
  const q = (sp.q ?? '').slice(0, 100);
  const tab = (LIBRARY_TABS as readonly string[]).includes(sp.tab ?? '')
    ? (sp.tab as LibraryTab)
    : 'all';
  const view: View = sp.view === 'grid' ? 'grid' : 'list';
  const filters = parseFilters(sp);
  const filtered = Object.keys(filters).length > 0;
  const state: State = { q, tab, view, ...filters };
  const db = getDb();
  const [result, options] = await Promise.all([
    listLibrary(db, user, { ...state, page: Number(sp.page) }),
    libraryFilterOptions(db, user),
  ]);
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
        <form
          role="search"
          action="/library"
          aria-label="Search and filter the library"
          className="flex flex-col gap-2"
        >
          {tab !== 'all' ? <input type="hidden" name="tab" value={tab} /> : null}
          {view === 'grid' ? <input type="hidden" name="view" value="grid" /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="library-search" className="sr-only">
              Search the library
            </label>
            <input
              id="library-search"
              name="q"
              defaultValue={q}
              type="search"
              placeholder="Search titles, passages, transcripts, people"
              className="box-border h-11 w-[380px] max-w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[14.5px]"
            />
            <button
              type="submit"
              className="inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-4 text-[14px] font-semibold"
            >
              Search
            </button>
            {q || filtered ? (
              <Link
                href={href({ tab, view })}
                className="inline-flex h-11 items-center px-2 text-[14px] font-semibold text-spruce"
              >
                Clear all
              </Link>
            ) : null}
          </div>
          <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
            <legend className="sr-only">Filters</legend>
            <label htmlFor="filter-book" className="sr-only">
              Book
            </label>
            <select
              id="filter-book"
              name="book"
              defaultValue={filters.book ?? ''}
              className={SELECT}
            >
              <option value="">Any book</option>
              {options.books.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <label htmlFor="filter-category" className="sr-only">
              Category
            </label>
            <select
              id="filter-category"
              name="category"
              defaultValue={filters.category ?? ''}
              className={SELECT}
            >
              <option value="">Any category</option>
              {CATEGORY_GROUPS.map(([kind, label]) => {
                const items = options.categories.filter((c) => c.kind === kind);
                return items.length ? (
                  <optgroup key={kind} label={label}>
                    {items.map((c) => (
                      <option key={c.name} value={`${c.kind}:${c.name}`}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
            <label htmlFor="filter-decade" className="sr-only">
              Decade
            </label>
            <select
              id="filter-decade"
              name="decade"
              defaultValue={filters.decade ? String(filters.decade) : ''}
              className={SELECT}
            >
              <option value="">Any decade</option>
              {options.decades.map((d) => (
                <option key={d} value={d}>
                  {d}s
                </option>
              ))}
            </select>
            <label htmlFor="filter-contributor" className="sr-only">
              Contributor
            </label>
            <select
              id="filter-contributor"
              name="contributor"
              defaultValue={filters.contributor ?? ''}
              className={SELECT}
            >
              <option value="">Anyone</option>
              {options.contributors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="inline-flex h-11 items-center rounded-[10px] bg-ink px-4 text-[14px] font-semibold text-white"
            >
              Apply filters
            </button>
          </fieldset>
        </form>

        {showTabs ? (
          <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            {LIBRARY_TABS.map((t) => (
              <Link
                key={t}
                href={href({ ...state, tab: t })}
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

        <nav aria-label="Layout" className="inline-flex gap-1 rounded-xl bg-chip p-1">
          {(['list', 'grid'] as const).map((v) => (
            <Link
              key={v}
              href={href({ ...state, view: v, page: result.page })}
              aria-current={v === view ? 'page' : undefined}
              className={`inline-flex h-11 items-center rounded-[9px] px-4 text-[13.5px] font-semibold ${
                v === view ? 'bg-surface text-ink' : 'text-muted'
              }`}
            >
              {v === 'list' ? 'List' : 'Grid'}
            </Link>
          ))}
        </nav>
      </div>

      <section
        aria-label="Sermons"
        className="overflow-hidden rounded-2xl border border-line bg-surface"
      >
        {result.rows.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="m-0 text-[16px] font-semibold">
              {q || filtered || tab !== 'all' ? 'No sermons match.' : 'No sermons yet.'}
            </p>
            <p className="mx-auto mb-0 mt-2 max-w-[420px] text-[14px] text-muted">
              {q || filtered || tab !== 'all'
                ? 'Try a different search, filter or status.'
                : user.role === 'viewer'
                  ? 'Approved sermons will appear here once they are filed.'
                  : canUpload
                    ? 'Upload a tape and it will show up here as it is processed.'
                    : 'Approved sermons will appear here.'}
            </p>
          </div>
        ) : view === 'grid' ? (
          <LibraryGrid rows={result.rows} />
        ) : (
          <>
            <ul className="m-0 list-none p-0 md:hidden" aria-label="Sermons">
              {result.rows.map((row) => {
                const recorded = formatRecordedOn(row.recordedOn);
                const detail = [row.side ? `Side ${row.side}` : null, row.batchLabel]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <li key={row.id} className="border-b border-chip px-4 py-4 last:border-b-0">
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        href={`/sermons/${row.id}`}
                        className="min-w-0 text-ink underline decoration-line-strong underline-offset-2"
                      >
                        {row.title ? (
                          <span className="font-semibold">{row.title}</span>
                        ) : (
                          <span className="break-all font-mono text-[13px] font-medium">
                            {row.filename ?? 'Untitled tape'}
                          </span>
                        )}
                      </Link>
                      <span className="flex-none">
                        <StatusChip status={row.status} />
                      </span>
                    </div>
                    {detail ? <div className="mt-0.5 text-[13px] text-muted">{detail}</div> : null}
                    {row.snippet ? <TranscriptSnippet text={row.snippet} /> : null}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13.5px] text-muted">
                      <span>{row.labelScripture ?? '—'}</span>
                      <span>
                        {recorded ?? (
                          <span className="font-semibold text-amber-text">Date needed</span>
                        )}
                      </span>
                      <span>{row.contributorName}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="hidden overflow-x-auto md:block">
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
                          <Link
                            href={`/sermons/${row.id}`}
                            className="text-ink underline decoration-line-strong underline-offset-2"
                          >
                            {row.title ? (
                              <span className="font-semibold">{row.title}</span>
                            ) : (
                              <span className="break-all font-mono text-[13px] font-medium">
                                {row.filename ?? 'Untitled tape'}
                              </span>
                            )}
                          </Link>
                          {detail ? (
                            <div className="mt-0.5 text-[13px] text-muted">{detail}</div>
                          ) : null}
                          {row.snippet ? <TranscriptSnippet text={row.snippet} /> : null}
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
          </>
        )}
        {result.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-chip bg-paper px-6 py-3 text-[13px] text-muted">
            <span>
              Showing {first}–{last} of {result.total}
            </span>
            <nav aria-label="Pages" className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={href({ ...state, page: result.page - 1 })}
                  className="inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-4 font-semibold text-ink"
                >
                  Previous
                </Link>
              ) : null}
              {result.page < result.pageCount ? (
                <Link
                  href={href({ ...state, page: result.page + 1 })}
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
