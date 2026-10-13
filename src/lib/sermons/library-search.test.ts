import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { scriptureRefs, sermons, sermonTags, tags, transcripts } from '@/db/schema';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import {
  libraryFilterOptions,
  listLibrary,
  parseFilters,
  searchPassage,
  SNIPPET_END,
  SNIPPET_START,
} from './library';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

type Owner = Awaited<ReturnType<typeof insertUser>>;

async function sermon(owner: Owner, over: Partial<typeof sermons.$inferInsert> = {}) {
  const [row] = await db
    .insert(sermons)
    .values({ contributorId: owner.id, status: 'approved', ...over })
    .returning();
  return row;
}

async function transcript(sermonId: string, fullText: string, version = 1) {
  await db.insert(transcripts).values({
    sermonId,
    version,
    model: 'fake',
    language: 'en',
    fullText,
    segments: [],
    lowConfidence: [],
  });
}

async function passage(
  sermonId: string,
  ref: { book: string; chapter: number; verseStart?: number; verseEnd?: number },
  over: Partial<typeof scriptureRefs.$inferInsert> = {},
) {
  await db.insert(scriptureRefs).values({
    sermonId,
    spokenAtSec: 10,
    source: 'auto',
    ...ref,
    ...over,
  });
}

async function tag(sermonId: string, kind: 'testament' | 'genre' | 'book' | 'topic', name: string) {
  await db.insert(tags).values({ kind, name }).onConflictDoNothing();
  const [{ id }] = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.kind, kind), eq(tags.name, name)));
  await db.insert(sermonTags).values({ sermonId, tagId: id });
}

const titles = (page: { rows: { title: string | null }[] }) => page.rows.map((r) => r.title).sort();

describe('searchPassage', () => {
  it.each([
    ['Heb 13:17', { book: 'Hebrews', chapter: 13, verseStart: 17, verseEnd: null }],
    ['romans 8', { book: 'Romans', chapter: 8, verseStart: null, verseEnd: null }],
    ['1 Peter 5:2-3', { book: '1 Peter', chapter: 5, verseStart: 2, verseEnd: 3 }],
    ['Hebrews', { book: 'Hebrews' }],
    ['is', null],
    ['grace', null],
    ['Hebrews 99', null],
  ])('%s', (q, expected) => expect(searchPassage(q)).toEqual(expected));
});

describe('passage search', () => {
  it('finds sermons whose named passages overlap the one searched', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const a = await sermon(owner, { title: 'verse 17' });
    await passage(a.id, { book: 'Hebrews', chapter: 13, verseStart: 17 });
    const b = await sermon(owner, { title: 'verses 15-18' });
    await passage(b.id, { book: 'Hebrews', chapter: 13, verseStart: 15, verseEnd: 18 });
    const c = await sermon(owner, { title: 'whole chapter' });
    await passage(c.id, { book: 'Hebrews', chapter: 13 });
    const d = await sermon(owner, { title: 'verse 5' });
    await passage(d.id, { book: 'Hebrews', chapter: 13, verseStart: 5 });
    const e = await sermon(owner, { title: 'chapter 12' });
    await passage(e.id, { book: 'Hebrews', chapter: 12, verseStart: 17 });
    const f = await sermon(owner, { title: 'deleted' });
    await passage(
      f.id,
      { book: 'Hebrews', chapter: 13, verseStart: 17 },
      { deletedAt: new Date() },
    );

    expect(titles(await listLibrary(db, admin, { q: 'Heb 13:17' }))).toEqual([
      'verse 17',
      'verses 15-18',
      'whole chapter',
    ]);
    expect((await listLibrary(db, admin, { q: 'hebrews 13' })).total).toBe(4);
    expect((await listLibrary(db, admin, { q: 'Hebrews' })).total).toBe(5);
  });

  it('matches the main passage even before it appears in the passage list', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    await sermon(owner, {
      title: 'main only',
      primaryPassage: { book: 'Romans', chapter: 8, verseStart: 28, verseEnd: 39 },
    });
    expect(titles(await listLibrary(db, admin, { q: 'Rom 8:30' }))).toEqual(['main only']);
    expect((await listLibrary(db, admin, { q: 'Rom 8:1' })).total).toBe(0);
  });
});

describe('transcript search', () => {
  it('matches words in the newest transcript and returns a highlighted snippet', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await sermon(owner, { title: 'Leaders' });
    await transcript(s.id, 'Obey them that have the rule over you, for they watch for your souls.');
    await sermon(owner, { title: 'Other' });

    const page = await listLibrary(db, admin, { q: 'watching souls' });
    expect(titles(page)).toEqual(['Leaders']);
    expect(page.rows[0].snippet).toContain(`${SNIPPET_START}watch${SNIPPET_END}`);
    expect(page.rows[0].snippet).toContain(`${SNIPPET_START}souls${SNIPPET_END}`);
  });

  it('ignores words that only an older transcript version had', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await sermon(owner, { title: 'Corrected' });
    await transcript(s.id, 'the brethren of Galilee', 1);
    await transcript(s.id, 'the brethren of Gilead', 2);
    expect((await listLibrary(db, admin, { q: 'galilee' })).total).toBe(0);
    expect((await listLibrary(db, admin, { q: 'gilead' })).total).toBe(1);
  });

  it('leaves the snippet empty when the match was not in the transcript', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await sermon(owner, { title: 'Grace abounding' });
    await transcript(s.id, 'nothing relevant here');
    const page = await listLibrary(db, admin, { q: 'grace' });
    expect(page.rows[0].snippet).toBeNull();
  });

  it('never reveals a hidden sermon through its transcript', async () => {
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const other = await insertUser(db, 'contributor');
    const s = await sermon(owner, { status: 'needs_review', title: 'Draft' });
    await transcript(s.id, 'a secret word: tabernacle');
    expect((await listLibrary(db, viewer, { q: 'tabernacle' })).total).toBe(0);
    expect((await listLibrary(db, other, { q: 'tabernacle' })).total).toBe(0);
    expect((await listLibrary(db, owner, { q: 'tabernacle' })).total).toBe(1);
  });
});

describe('filters', () => {
  it('filters by book, category, decade and contributor, and combines them', async () => {
    const ruth = await insertUser(db, 'contributor', { name: 'Ruth' });
    const amos = await insertUser(db, 'contributor', { name: 'Amos' });
    const admin = await insertUser(db, 'admin');
    const a = await sermon(ruth, { title: 'a', recordedOn: '1988-03-13' });
    await tag(a.id, 'book', 'Hebrews');
    await tag(a.id, 'genre', 'Epistle');
    await tag(a.id, 'topic', 'Leadership');
    const b = await sermon(amos, { title: 'b', recordedOn: '1993-06-01' });
    await tag(b.id, 'book', 'Psalms');
    await tag(b.id, 'genre', 'Psalm');
    const c = await sermon(ruth, { title: 'c', recordedOn: '1990-01-01' });
    await tag(c.id, 'book', 'Romans');
    await tag(c.id, 'genre', 'Epistle');
    await sermon(ruth, { title: 'undated' });

    const find = async (f: Record<string, string>) =>
      titles(await listLibrary(db, admin, parseFilters(f)));
    expect(await find({ book: 'Hebrews' })).toEqual(['a']);
    expect(await find({ category: 'genre:Epistle' })).toEqual(['a', 'c']);
    expect(await find({ category: 'topic:leadership' })).toEqual(['a']);
    expect(await find({ decade: '1990' })).toEqual(['b', 'c']);
    expect(await find({ decade: '1980' })).toEqual(['a']);
    expect(await find({ contributor: amos.id })).toEqual(['b']);
    expect(await find({ contributor: ruth.id, decade: '1990' })).toEqual(['c']);
    expect(await find({ category: 'genre:Epistle', decade: '1980' })).toEqual(['a']);
  });

  it('drops malformed filter values instead of failing', () => {
    expect(
      parseFilters({
        book: 'Hezekiah',
        category: 'book:Hebrews',
        decade: '1985',
        contributor: "1' or 1=1",
      }),
    ).toEqual({});
    expect(parseFilters({ book: 'hebrews', category: 'genre:Epistle', decade: '1980' })).toEqual({
      book: 'Hebrews',
      category: 'genre:Epistle',
      decade: 1980,
    });
  });

  it('never shows a hidden sermon, whatever the filter', async () => {
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const s = await sermon(owner, { status: 'needs_review', recordedOn: '1988-01-01' });
    await tag(s.id, 'book', 'Hebrews');
    const page = await listLibrary(db, viewer, {
      book: 'Hebrews',
      decade: 1980,
      contributor: owner.id,
    });
    expect(page.total).toBe(0);
  });
});

describe('libraryFilterOptions', () => {
  it('offers only values from sermons the person can see', async () => {
    const shown = await insertUser(db, 'contributor', { name: 'Shown' });
    const hidden = await insertUser(db, 'contributor', { name: 'Hidden' });
    const viewer = await insertUser(db, 'viewer');
    const admin = await insertUser(db, 'admin');
    const a = await sermon(shown, { recordedOn: '1988-03-13' });
    await tag(a.id, 'book', 'Romans');
    await tag(a.id, 'book', 'Genesis');
    await tag(a.id, 'testament', 'New Testament');
    await tag(a.id, 'topic', 'Grace');
    const b = await sermon(hidden, { status: 'needs_review', recordedOn: '1975-01-01' });
    await tag(b.id, 'book', 'Jude');
    await tag(b.id, 'topic', 'Secret topic');

    const forViewer = await libraryFilterOptions(db, viewer);
    expect(forViewer).toEqual({
      books: ['Genesis', 'Romans'],
      categories: [
        { kind: 'testament', name: 'New Testament' },
        { kind: 'topic', name: 'Grace' },
      ],
      decades: [1980],
      contributors: [{ id: shown.id, name: 'Shown' }],
    });

    const forAdmin = await libraryFilterOptions(db, admin);
    expect(forAdmin.books).toEqual(['Genesis', 'Romans', 'Jude']);
    expect(forAdmin.decades).toEqual([1970, 1980]);
    expect(forAdmin.contributors.map((c) => c.name)).toEqual(['Hidden', 'Shown']);
  });
});
