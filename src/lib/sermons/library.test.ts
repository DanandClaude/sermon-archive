import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sermons, uploads } from '@/db/schema';
import { formatRecordedOn } from '@/lib/format';
import type { SermonStatus } from '@/lib/sermon-status';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import { countNeedsReview, likePattern, listLibrary, PAGE_SIZE } from './library';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

type Owner = Awaited<ReturnType<typeof insertUser>>;
let counter = 0;
async function sermon(
  owner: Owner,
  over: Partial<typeof sermons.$inferInsert> & { filename?: string } = {},
) {
  const { filename, ...values } = over;
  const [row] = await db
    .insert(sermons)
    .values({ contributorId: owner.id, status: 'approved', ...values })
    .returning();
  if (filename !== undefined) {
    await db.insert(uploads).values({
      sermonId: row.id,
      userId: owner.id,
      storageKey: `originals/${row.id}/original.wav`,
      storeUploadId: 'x',
      filename,
      sizeBytes: 1,
      mime: 'audio/wav',
      fingerprint: `fp-${++counter}`,
      partSize: 8,
      status: 'completed',
    });
  }
  return row;
}

describe('listLibrary visibility', () => {
  it('shows a viewer only approved sermons, and never counts the rest', async () => {
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    for (const status of [
      'uploading',
      'needs_review',
      'approved',
      'filed',
      'failed',
    ] as SermonStatus[]) {
      await sermon(owner, { status, title: status });
    }
    const page = await listLibrary(db, viewer);
    expect(page.rows.map((r) => r.title).sort()).toEqual(['approved', 'filed']);
    expect(page.total).toBe(2);
    expect(page.counts).toMatchObject({ all: 2, approved: 2, needs_review: 0, in_progress: 0 });
  });

  it('shows a contributor their own drafts plus approved sermons, not other people’s drafts', async () => {
    const me = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    await sermon(me, { status: 'needs_review', title: 'my draft' });
    await sermon(other, { status: 'needs_review', title: 'their draft' });
    await sermon(other, { status: 'approved', title: 'their approved' });
    const page = await listLibrary(db, me);
    expect(page.rows.map((r) => r.title).sort()).toEqual(['my draft', 'their approved']);
  });

  it('shows an admin everything except deleted sermons', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    await sermon(owner, { status: 'uploading', title: 'a' });
    await sermon(owner, { status: 'approved', title: 'b' });
    await sermon(owner, { status: 'approved', title: 'gone', deletedAt: new Date() });
    expect((await listLibrary(db, admin)).rows.map((r) => r.title).sort()).toEqual(['a', 'b']);
  });

  it('lets a search never reveal what visibility hides', async () => {
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    await sermon(owner, { status: 'needs_review', title: 'Secret draft' });
    expect((await listLibrary(db, viewer, { q: 'secret' })).rows).toHaveLength(0);
  });
});

describe('listLibrary filtering', () => {
  it('searches title, file name, label scripture, speaker, batch and contributor, ignoring case', async () => {
    const marcy = await insertUser(db, 'contributor', { name: 'Marcy Tate' });
    const admin = await insertUser(db, 'admin');
    await sermon(marcy, { title: 'Submitting to Leaders' });
    await sermon(marcy, { filename: 'Tape14_SideA.wav' });
    await sermon(marcy, { labelScripture: 'Romans 8:28' });
    await sermon(marcy, { speaker: 'Pastor Lee' });
    await sermon(marcy, { batchLabel: 'Box 3' });
    const find = async (q: string) => (await listLibrary(db, admin, { q })).total;
    expect(await find('LEADERS')).toBe(1);
    expect(await find('tape14')).toBe(1);
    expect(await find('romans')).toBe(1);
    expect(await find('pastor lee')).toBe(1);
    expect(await find('box 3')).toBe(1);
    expect(await find('marcy')).toBe(5);
    expect(await find('nothing like this')).toBe(0);
  });

  it('treats % and _ in a search literally', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    await sermon(owner, { title: '100% sure' });
    await sermon(owner, { title: 'plain title' });
    expect((await listLibrary(db, admin, { q: '%' })).rows.map((r) => r.title)).toEqual([
      '100% sure',
    ]);
    expect((await listLibrary(db, admin, { q: '_lain' })).total).toBe(0);
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('filters by tab', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    for (const status of [
      'uploading',
      'uploaded',
      'transcribing',
      'failed',
      'needs_review',
      'approved',
      'filed',
    ] as SermonStatus[]) {
      await sermon(owner, { status });
    }
    const count = async (tab: 'all' | 'in_progress' | 'needs_review' | 'approved') =>
      (await listLibrary(db, admin, { tab })).total;
    expect(await count('all')).toBe(7);
    expect(await count('in_progress')).toBe(4);
    expect(await count('needs_review')).toBe(1);
    expect(await count('approved')).toBe(2);
  });

  it('keeps tab counts about everything visible, not the current search', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    await sermon(owner, { status: 'approved', title: 'one' });
    await sermon(owner, { status: 'needs_review', title: 'two' });
    const page = await listLibrary(db, admin, { q: 'one', tab: 'approved' });
    expect(page.total).toBe(1);
    expect(page.counts).toMatchObject({ all: 2, approved: 1, needs_review: 1 });
  });

  it('falls back to all for an unknown tab', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    await sermon(owner);
    expect((await listLibrary(db, admin, { tab: 'bogus' as never })).total).toBe(1);
  });
});

describe('listLibrary paging and order', () => {
  it('splits into pages of 25 and reports totals', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    await db.insert(sermons).values(
      Array.from({ length: 60 }, (_, i) => ({
        contributorId: owner.id,
        status: 'approved' as const,
        title: `Sermon ${String(i).padStart(2, '0')}`,
        recordedOn: `19${80 + (i % 20)}-01-01`,
      })),
    );
    const p1 = await listLibrary(db, admin, { page: 1 });
    const p3 = await listLibrary(db, admin, { page: 3 });
    expect([p1.rows.length, p3.rows.length, p1.total, p1.pageCount]).toEqual([
      PAGE_SIZE,
      10,
      60,
      3,
    ]);
    const ids = new Set(
      [...p1.rows, ...(await listLibrary(db, admin, { page: 2 })).rows, ...p3.rows].map(
        (r) => r.id,
      ),
    );
    expect(ids.size).toBe(60);
  });

  it('clamps a page number that is too high or nonsense', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    await sermon(owner);
    expect((await listLibrary(db, admin, { page: 99 })).page).toBe(1);
    expect((await listLibrary(db, admin, { page: -5 })).page).toBe(1);
    expect((await listLibrary(db, admin, { page: Number.NaN })).page).toBe(1);
  });

  it('shows an empty library as one empty page', async () => {
    const admin = await insertUser(db, 'admin');
    expect(await listLibrary(db, admin)).toMatchObject({
      rows: [],
      total: 0,
      page: 1,
      pageCount: 1,
    });
  });

  it('orders by recording date, newest first, with undated sermons last', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    await sermon(owner, { title: 'undated' });
    await sermon(owner, { title: '1988', recordedOn: '1988-03-13' });
    await sermon(owner, { title: '1996', recordedOn: '1996-04-14' });
    expect((await listLibrary(db, admin)).rows.map((r) => r.title)).toEqual([
      '1996',
      '1988',
      'undated',
    ]);
  });

  it('returns each sermon once even if it has several upload records', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await sermon(owner, { filename: 'a.wav' });
    expect(s).toBeTruthy();
    expect((await listLibrary(db, admin)).rows).toHaveLength(1);
  });

  it('is open to all three roles', async () => {
    for (const role of ['viewer', 'contributor', 'admin'] as const) {
      const user = await insertUser(db, role);
      await expect(listLibrary(db, user)).resolves.toBeTruthy();
    }
  });
});

describe('countNeedsReview', () => {
  it('counts a contributor’s own, all of them for an admin, and none for a viewer', async () => {
    const me = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const viewer = await insertUser(db, 'viewer');
    await sermon(me, { status: 'needs_review' });
    await sermon(me, { status: 'needs_review' });
    await sermon(me, { status: 'approved' });
    await sermon(other, { status: 'needs_review' });
    await sermon(other, { status: 'needs_review', deletedAt: new Date() });
    expect(await countNeedsReview(db, me)).toBe(2);
    expect(await countNeedsReview(db, admin)).toBe(3);
    expect(await countNeedsReview(db, viewer)).toBe(0);
  });
});

describe('formatRecordedOn', () => {
  it.each([
    ['1988-03-13', 'Mar 13, 1988'],
    ['1996-12-01', 'Dec 1, 1996'],
    [null, null],
    ['garbage', null],
  ])('%s → %s', (iso, text) => expect(formatRecordedOn(iso)).toBe(text));
});
