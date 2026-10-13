import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Db } from '@/db/client';
import { scriptureRefs, sermons, sermonTags, tags, transcripts, uploads, users } from '@/db/schema';
import { assertCan, type Actor } from '@/lib/permissions';
import {
  CANON,
  findBook,
  parseReferenceText,
  resolveBook,
  type Reference,
} from '@/lib/scripture/canon';
import { isApprovedOrLater, SERMON_STATUSES, type SermonStatus } from '@/lib/sermon-status';
import { visibleSermons } from './visibility';

export const PAGE_SIZE = 25;

export const LIBRARY_TABS = ['all', 'in_progress', 'needs_review', 'approved'] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

const IN_PROGRESS: SermonStatus[] = [
  'uploading',
  'uploaded',
  'cleaning',
  'transcribing',
  'analyzing',
  'failed',
];
const APPROVED = SERMON_STATUSES.filter(isApprovedOrLater);

function tabCondition(tab: LibraryTab): SQL | undefined {
  if (tab === 'in_progress') return inArray(sermons.status, IN_PROGRESS);
  if (tab === 'needs_review') return eq(sermons.status, 'needs_review');
  if (tab === 'approved') return inArray(sermons.status, APPROVED);
  return undefined;
}

/** Escapes % and _ so search text is matched literally rather than as a pattern. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Marks around the matching words in a transcript snippet. Control characters never occur in transcripts. */
export const SNIPPET_START = '\u0001';
export const SNIPPET_END = '\u0002';

/** The passage a search names, if it names one: "Heb 13:17", "Romans 8", or a book spelled out. */
export function searchPassage(q: string): Reference | { book: string } | null {
  const text = q.trim();
  const parsed = parseReferenceText(text);
  if (parsed.ok) return parsed.ref;
  // A bare book needs its full name: "is" or "ex" alone are words, not Isaiah or Exodus.
  const book = resolveBook(text, { abbreviations: false });
  return book ? { book: book.name } : null;
}

/** Drizzle's exists() leaves out the brackets a raw subquery needs. */
const exists = (subquery: SQL) => sql`exists (${subquery})`;

/** Live passages (or the main text) that overlap the one searched for. */
function passageCondition(target: Reference | { book: string }): SQL {
  const conditions: SQL[] = [
    eq(scriptureRefs.sermonId, sermons.id),
    isNull(scriptureRefs.deletedAt),
    eq(scriptureRefs.book, target.book),
  ];
  const main = [sql`${sermons.primaryPassage}->>'book' = ${target.book}`];
  if ('chapter' in target) {
    conditions.push(eq(scriptureRefs.chapter, target.chapter));
    main.push(sql`(${sermons.primaryPassage}->>'chapter')::int = ${target.chapter}`);
    if (target.verseStart !== null) {
      const from = target.verseStart;
      const to = target.verseEnd ?? target.verseStart;
      // A passage without verses is the whole chapter, so it overlaps any verse in it.
      conditions.push(
        sql`(${scriptureRefs.verseStart} is null or (${scriptureRefs.verseStart} <= ${to} and coalesce(${scriptureRefs.verseEnd}, ${scriptureRefs.verseStart}) >= ${from}))`,
      );
      main.push(
        sql`(${sermons.primaryPassage}->>'verseStart' is null or ((${sermons.primaryPassage}->>'verseStart')::int <= ${to} and coalesce((${sermons.primaryPassage}->>'verseEnd')::int, (${sermons.primaryPassage}->>'verseStart')::int) >= ${from}))`,
      );
    }
  }
  return or(exists(sql`select 1 from ${scriptureRefs} where ${and(...conditions)}`), and(...main))!;
}

const tsQuery = (text: string) => sql`websearch_to_tsquery('english', ${text})`;

/** Only the newest transcript counts: a corrected line should stop matching what was misheard. */
const latestTranscript = sql`${transcripts.version} = (select max(t2.version) from ${transcripts} t2 where t2.sermon_id = ${transcripts.sermonId})`;

function transcriptCondition(text: string): SQL {
  return exists(
    sql`select 1 from ${transcripts} where ${transcripts.sermonId} = ${sermons.id} and ${latestTranscript} and ${transcripts.searchVector} @@ ${tsQuery(text)}`,
  );
}

function searchCondition(q: string): SQL | undefined {
  const text = q.trim();
  if (!text) return undefined;
  const pattern = likePattern(text);
  const passage = searchPassage(text);
  return or(
    ilike(sermons.title, pattern),
    ilike(uploads.filename, pattern),
    ilike(sermons.labelScripture, pattern),
    ilike(sermons.speaker, pattern),
    ilike(sermons.batchLabel, pattern),
    ilike(users.name, pattern),
    passage ? passageCondition(passage) : undefined,
    transcriptCondition(text),
  );
}

export const CATEGORY_KINDS = ['testament', 'genre', 'topic'] as const;
type CategoryKind = (typeof CATEGORY_KINDS)[number];

export type LibraryFilters = {
  /** A canon book name. */
  book?: string;
  /** A testament, genre or topic tag, as `kind:name`. */
  category?: string;
  /** The first year of a decade, such as 1980. */
  decade?: number;
  /** A contributor's user id. */
  contributor?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads filters from the address bar, dropping anything malformed rather than failing the page. */
export function parseFilters(params: Record<string, string | undefined>): LibraryFilters {
  const filters: LibraryFilters = {};
  const book = params.book ? findBook(params.book) : undefined;
  if (book) filters.book = book.name;
  const category = parseCategory(params.category);
  if (category) filters.category = `${category.kind}:${category.name}`;
  const decade = Number(params.decade);
  if (Number.isInteger(decade) && decade % 10 === 0 && decade >= 1900 && decade <= 2100) {
    filters.decade = decade;
  }
  if (params.contributor && UUID.test(params.contributor)) {
    filters.contributor = params.contributor.toLowerCase();
  }
  return filters;
}

function parseCategory(value: string | undefined): { kind: CategoryKind; name: string } | null {
  if (!value) return null;
  const at = value.indexOf(':');
  const kind = value.slice(0, at) as CategoryKind;
  const name = value.slice(at + 1).trim();
  if (at < 0 || !CATEGORY_KINDS.includes(kind) || !name || name.length > 100) return null;
  return { kind, name };
}

const hasTag = (kind: string, name: string) =>
  exists(
    sql`select 1 from ${sermonTags} join ${tags} on ${tags.id} = ${sermonTags.tagId} where ${sermonTags.sermonId} = ${sermons.id} and ${tags.kind} = ${kind} and lower(${tags.name}) = lower(${name})`,
  );

function filterConditions(filters: LibraryFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.book) conditions.push(hasTag('book', filters.book));
  const category = parseCategory(filters.category);
  if (category) conditions.push(hasTag(category.kind, category.name));
  if (filters.decade !== undefined) {
    conditions.push(
      gte(sermons.recordedOn, `${filters.decade}-01-01`),
      lt(sermons.recordedOn, `${filters.decade + 10}-01-01`),
    );
  }
  if (filters.contributor) conditions.push(eq(sermons.contributorId, filters.contributor));
  return conditions;
}

export type LibraryRow = {
  id: string;
  title: string | null;
  filename: string | null;
  labelScripture: string | null;
  recordedOn: string | null;
  status: SermonStatus;
  side: string | null;
  batchLabel: string | null;
  contributorName: string;
  summary: string | null;
  durationSec: number | null;
  /** Where the search words occur in the transcript, between SNIPPET_START and SNIPPET_END. */
  snippet: string | null;
};

export type LibraryPage = {
  rows: LibraryRow[];
  total: number;
  page: number;
  pageCount: number;
  counts: Record<LibraryTab, number>;
};

/**
 * One page of the library. Visibility is part of the query, so people never receive sermons
 * they may not see, and counts and page numbers only ever describe what they can see.
 */
export async function listLibrary(
  db: Db,
  actor: Actor,
  filters: { q?: string; tab?: LibraryTab; page?: number } & LibraryFilters = {},
): Promise<LibraryPage> {
  assertCan(actor.role, 'library.browse');
  const tab = filters.tab && LIBRARY_TABS.includes(filters.tab) ? filters.tab : 'all';
  const visible = visibleSermons(actor);
  const q = (filters.q ?? '').trim();
  const where = and(visible, tabCondition(tab), searchCondition(q), ...filterConditions(filters));

  const [{ total }] = await db
    .select({ total: count() })
    .from(sermons)
    .innerJoin(users, eq(users.id, sermons.contributorId))
    .leftJoin(uploads, eq(uploads.sermonId, sermons.id))
    .where(where);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(filters.page ?? 1) || 1), pageCount);

  const found = await db
    .select({
      id: sermons.id,
      title: sermons.title,
      filename: uploads.filename,
      labelScripture: sermons.labelScripture,
      recordedOn: sermons.recordedOn,
      status: sermons.status,
      side: sermons.side,
      batchLabel: sermons.batchLabel,
      contributorName: users.name,
      summary: sermons.summaryText,
      durationSec: sermons.durationSec,
    })
    .from(sermons)
    .innerJoin(users, eq(users.id, sermons.contributorId))
    .leftJoin(uploads, eq(uploads.sermonId, sermons.id))
    .where(where)
    .orderBy(sql`${sermons.recordedOn} desc nulls last`, desc(sermons.createdAt), desc(sermons.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const snippets = q
    ? await transcriptSnippets(
        db,
        q,
        found.map((r) => r.id),
      )
    : new Map();
  const rows = found.map((r) => ({ ...r, snippet: snippets.get(r.id) ?? null }));

  // Tab counts describe everything the person can see, ignoring the search box, filters and current tab.
  const [counts] = await db
    .select({
      all: count(),
      in_progress: sql<number>`count(*) filter (where ${inArray(sermons.status, IN_PROGRESS)})::int`,
      needs_review: sql<number>`count(*) filter (where ${eq(sermons.status, 'needs_review')})::int`,
      approved: sql<number>`count(*) filter (where ${inArray(sermons.status, APPROVED)})::int`,
    })
    .from(sermons)
    .where(visible);

  return { rows, total, page, pageCount, counts };
}

/** A short excerpt around the search words, for the rows on this page whose transcript matched. */
async function transcriptSnippets(db: Db, q: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const found = await db
    .select({
      sermonId: transcripts.sermonId,
      snippet: sql<string>`ts_headline('english', ${transcripts.fullText}, ${tsQuery(q)}, ${`StartSel=${SNIPPET_START}, StopSel=${SNIPPET_END}, MaxWords=24, MinWords=12, MaxFragments=1`})`,
    })
    .from(transcripts)
    .where(
      and(
        inArray(transcripts.sermonId, ids),
        latestTranscript,
        sql`${transcripts.searchVector} @@ ${tsQuery(q)}`,
      ),
    );
  return new Map(found.map((r) => [r.sermonId, r.snippet]));
}

export type FilterOptions = {
  books: string[];
  categories: { kind: CategoryKind; name: string }[];
  decades: number[];
  contributors: { id: string; name: string }[];
};

/** What each filter can offer: only values found on sermons this person can see. */
export async function libraryFilterOptions(db: Db, actor: Actor): Promise<FilterOptions> {
  assertCan(actor.role, 'library.browse');
  const visible = visibleSermons(actor);
  const [tagRows, decadeRows, contributors] = await Promise.all([
    db
      .selectDistinct({ kind: tags.kind, name: tags.name })
      .from(tags)
      .innerJoin(sermonTags, eq(sermonTags.tagId, tags.id))
      .innerJoin(sermons, eq(sermons.id, sermonTags.sermonId))
      .where(and(visible, inArray(tags.kind, ['book', ...CATEGORY_KINDS])))
      .orderBy(asc(tags.kind), asc(tags.name)),
    db
      .selectDistinct({
        decade: sql<number>`(extract(year from ${sermons.recordedOn})::int / 10 * 10)`,
      })
      .from(sermons)
      .where(and(visible, isNotNull(sermons.recordedOn)))
      .orderBy(sql`1`),
    db
      .selectDistinct({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(sermons, eq(sermons.contributorId, users.id))
      .where(visible)
      .orderBy(asc(users.name), asc(users.id)),
  ]);
  const canonOrder = new Map(CANON.map((b, i) => [b.name, i]));
  return {
    books: tagRows
      .filter((t) => t.kind === 'book' && canonOrder.has(t.name))
      .map((t) => t.name)
      .sort((a, b) => canonOrder.get(a)! - canonOrder.get(b)!),
    categories: tagRows.filter((t): t is { kind: CategoryKind; name: string } =>
      (CATEGORY_KINDS as readonly string[]).includes(t.kind),
    ),
    decades: decadeRows.map((r) => r.decade),
    contributors,
  };
}

/** The badge next to "Needs review": a contributor's own sermons waiting on them, or all of them for an admin. */
export async function countNeedsReview(db: Db, actor: Actor): Promise<number> {
  if (actor.role === 'viewer') return 0;
  const conditions = [isNull(sermons.deletedAt), eq(sermons.status, 'needs_review')];
  if (actor.role === 'contributor') conditions.push(eq(sermons.contributorId, actor.id));
  const [{ n }] = await db
    .select({ n: count() })
    .from(sermons)
    .where(and(...conditions));
  return n;
}
