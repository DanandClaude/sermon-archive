import { and, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { sermons, uploads, users } from '@/db/schema';
import { assertCan, type Actor } from '@/lib/permissions';
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

function searchCondition(q: string): SQL | undefined {
  const text = q.trim();
  if (!text) return undefined;
  const pattern = likePattern(text);
  return or(
    ilike(sermons.title, pattern),
    ilike(uploads.filename, pattern),
    ilike(sermons.labelScripture, pattern),
    ilike(sermons.speaker, pattern),
    ilike(sermons.batchLabel, pattern),
    ilike(users.name, pattern),
  );
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
  filters: { q?: string; tab?: LibraryTab; page?: number } = {},
): Promise<LibraryPage> {
  assertCan(actor.role, 'library.browse');
  const tab = filters.tab && LIBRARY_TABS.includes(filters.tab) ? filters.tab : 'all';
  const visible = visibleSermons(actor);
  const where = and(visible, tabCondition(tab), searchCondition(filters.q ?? ''));

  const [{ total }] = await db
    .select({ total: count() })
    .from(sermons)
    .innerJoin(users, eq(users.id, sermons.contributorId))
    .leftJoin(uploads, eq(uploads.sermonId, sermons.id))
    .where(where);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(filters.page ?? 1) || 1), pageCount);

  const rows = await db
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
    })
    .from(sermons)
    .innerJoin(users, eq(users.id, sermons.contributorId))
    .leftJoin(uploads, eq(uploads.sermonId, sermons.id))
    .where(where)
    .orderBy(sql`${sermons.recordedOn} desc nulls last`, desc(sermons.createdAt), desc(sermons.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  // Tab counts describe everything the person can see, ignoring the search box and current tab.
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
