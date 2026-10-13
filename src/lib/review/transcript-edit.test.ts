import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, sermons, transcripts } from '@/db/schema';
import type { SermonStatus } from '@/lib/sermon-status';
import type { Segment } from '@/lib/transcripts/render';
import { toSrt } from '@/lib/transcripts/render';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import { editTranscriptLine, retimeWords, ReviewError } from './service';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

type User = Awaited<ReturnType<typeof insertUser>>;
const w = (word: string, start: number, end: number, prob = 0.9) => ({ w: word, start, end, prob });
const SEGMENTS: Segment[] = [
  {
    start: 0,
    end: 2,
    text: 'Turn to He brews.',
    words: [w('Turn', 0, 0.4), w('to', 0.4, 0.6), w('He', 0.6, 1), w('brews.', 1, 2, 0.3)],
  },
  {
    start: 2,
    end: 4,
    text: 'Chapter thirteen.',
    words: [w('Chapter', 2, 3), w('thirteen.', 3, 4, 0.4)],
  },
];

async function sermonWithTranscript(owner: User, status: SermonStatus = 'needs_review') {
  const [s] = await db
    .insert(sermons)
    .values({ contributorId: owner.id, status, title: 'T' })
    .returning();
  await db.insert(transcripts).values({
    sermonId: s.id,
    version: 1,
    model: 'large-v3',
    language: 'en',
    fullText: 'Turn to He brews. Chapter thirteen.',
    segments: SEGMENTS,
    lowConfidence: [
      [0, 3],
      [1, 1],
    ],
  });
  return s;
}
const latest = async (sermonId: string) =>
  (
    await db
      .select()
      .from(transcripts)
      .where(eq(transcripts.sermonId, sermonId))
      .orderBy(desc(transcripts.version))
      .limit(1)
  )[0];
const rejects = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(ReviewError);
  expect((error as ReviewError).code).toBe(code);
};

describe('retimeWords', () => {
  it('keeps each word’s timing when only spellings change', () => {
    const words = retimeWords(SEGMENTS[1], 'Chapter 13.');
    expect(words.map((x) => [x.w, x.start, x.end])).toEqual([
      ['Chapter', 2, 3],
      ['13.', 3, 4],
    ]);
    expect(words[0].prob).toBe(0.9);
    expect(words[1].prob).toBe(1);
  });

  it('shares the line’s time out when the number of words changes', () => {
    const words = retimeWords(SEGMENTS[0], 'Turn to Hebrews.');
    expect(words.map((x) => x.w)).toEqual(['Turn', 'to', 'Hebrews.']);
    expect(words[0].start).toBe(0);
    expect(words.at(-1)!.end).toBe(2);
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBe(words[i - 1].end);
  });
});

describe('editTranscriptLine', () => {
  it('saves a new version, keeps the old one, and clears the checked line’s doubtful words', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await sermonWithTranscript(owner);
    const result = await editTranscriptLine(db, owner, s.id, {
      version: 1,
      index: 0,
      text: '  Turn to   Hebrews. ',
    });
    expect(result).toEqual({ version: 2 });
    const row = await latest(s.id);
    const segments = row.segments as Segment[];
    expect(segments[0].text).toBe('Turn to Hebrews.');
    expect(segments[1]).toEqual(SEGMENTS[1]);
    expect(row.fullText).toBe('Turn to Hebrews. Chapter thirteen.');
    expect(row.lowConfidence).toEqual([[1, 1]]);
    expect(row.model).toBe('large-v3');
    expect(await db.select().from(transcripts)).toHaveLength(2);
    expect(toSrt(segments)).toContain('Turn to Hebrews.');
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'transcript.edit'));
    expect(audit.diff).toMatchObject({
      line: 0,
      from: 'Turn to He brews.',
      to: 'Turn to Hebrews.',
    });
  });

  it('does nothing when the text is unchanged', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await sermonWithTranscript(owner);
    expect(
      await editTranscriptLine(db, owner, s.id, {
        version: 1,
        index: 1,
        text: 'Chapter thirteen.',
      }),
    ).toEqual({
      version: 1,
    });
    expect(await db.select().from(transcripts)).toHaveLength(1);
  });

  it('refuses a stale version, a missing line and an empty line', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await sermonWithTranscript(owner);
    await editTranscriptLine(db, owner, s.id, { version: 1, index: 0, text: 'Turn to Hebrews.' });
    await rejects(
      editTranscriptLine(db, owner, s.id, { version: 1, index: 1, text: 'x' }),
      'conflict',
    );
    await rejects(
      editTranscriptLine(db, owner, s.id, { version: 2, index: 9, text: 'x' }),
      'invalid',
    );
    await rejects(
      editTranscriptLine(db, owner, s.id, { version: 2, index: 0, text: '  ' }),
      'invalid',
    );
  });

  it('follows the review rules: own sermons, admins any, never viewers, not while processing', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const admin = await insertUser(db, 'admin');
    const s = await sermonWithTranscript(owner);
    const edit = (u: User, version: number) =>
      editTranscriptLine(db, u, s.id, { version, index: 0, text: `Edit ${version}` });
    await rejects(edit(other, 1), 'not_found');
    await expect(edit(viewer, 1)).rejects.toThrow();
    await edit(admin, 1);
    const busy = await sermonWithTranscript(owner, 'analyzing');
    await rejects(
      editTranscriptLine(db, owner, busy.id, { version: 1, index: 0, text: 'x' }),
      'conflict',
    );
  });
});
