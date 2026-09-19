import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, jobs, scriptureRefs, sermonTags, sermons, tags, uploads } from '@/db/schema';
import type { SermonStatus } from '@/lib/sermon-status';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import {
  addScriptureRef,
  approvalProblems,
  approveSermon,
  deleteScriptureRef,
  editScriptureRef,
  requestRegenerate,
  ReviewError,
  saveSummary,
  updateDetails,
} from './service';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

type User = Awaited<ReturnType<typeof insertUser>>;

async function sermonFor(
  owner: User,
  status: SermonStatus = 'needs_review',
  over: Partial<typeof sermons.$inferInsert> = {},
) {
  const [s] = await db
    .insert(sermons)
    .values({
      contributorId: owner.id,
      status,
      title: 'Submitting to Leaders',
      durationSec: 2700,
      ...over,
    })
    .returning();
  await db.insert(uploads).values({
    sermonId: s.id,
    userId: owner.id,
    storageKey: `originals/${s.id}/original.wav`,
    storeUploadId: 'x',
    filename: 'Tape14_SideA.wav',
    sizeBytes: 1,
    mime: 'audio/wav',
    fingerprint: `fp-${s.id}`,
    partSize: 8,
    status: 'completed',
  });
  return s;
}
const readySermon = (owner: User, over: Partial<typeof sermons.$inferInsert> = {}) =>
  sermonFor(owner, 'needs_review', {
    recordedOn: '1988-03-13',
    primaryPassage: { book: 'Hebrews', chapter: 13, verseStart: 17, verseEnd: null },
    ...over,
  });
const get = async (id: string) => (await db.select().from(sermons).where(eq(sermons.id, id)))[0];
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const rejects = async (promise: Promise<unknown>, code: string, field?: string) => {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(ReviewError);
  expect((error as ReviewError).code).toBe(code);
  if (field) expect((error as ReviewError).fieldErrors).toHaveProperty([field]);
  return error as ReviewError;
};
const tagNames = async (sermonId: string) =>
  (
    await db
      .select({ kind: tags.kind, name: tags.name })
      .from(sermonTags)
      .innerJoin(tags, eq(tags.id, sermonTags.tagId))
      .where(eq(sermonTags.sermonId, sermonId))
  )
    .map((t) => `${t.kind}:${t.name}`)
    .sort();
const ref = {
  book: 'Hebrews',
  chapter: 13,
  verseStart: 17,
  verseEnd: null,
  spokenAtSec: 1258,
  contextNote: 'Obey them that have the rule',
  isMainText: false,
};

describe('who can change what', () => {
  it('lets the uploader edit a sermon that is waiting for review, and an admin edit any', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await sermonFor(owner);
    await expect(updateDetails(db, owner, s.id, { title: 'One' })).resolves.toMatchObject({
      changed: ['title'],
    });
    await expect(updateDetails(db, admin, s.id, { title: 'Two' })).resolves.toMatchObject({
      changed: ['title'],
    });
  });

  it('tells other contributors and viewers the sermon does not exist', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const s = await sermonFor(owner);
    await rejects(updateDetails(db, other, s.id, { title: 'x' }), 'not_found');
    await rejects(updateDetails(db, viewer, s.id, { title: 'x' }), 'not_found');
    await rejects(saveSummary(db, other, s.id, 'x'), 'not_found');
    await rejects(addScriptureRef(db, other, s.id, ref), 'not_found');
    await rejects(requestRegenerate(db, other, s.id), 'not_found');
    expect((await get(s.id)).title).toBe('Submitting to Leaders');
  });

  it('tells a viewer who can see an approved sermon that they may not change it', async () => {
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const s = await sermonFor(owner, 'approved');
    await rejects(updateDetails(db, viewer, s.id, { title: 'x' }), 'forbidden');
  });

  it('stops the uploader once approved, but lets an admin carry on', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await sermonFor(owner, 'approved');
    await rejects(updateDetails(db, owner, s.id, { title: 'x' }), 'forbidden');
    await expect(updateDetails(db, admin, s.id, { title: 'Fixed' })).resolves.toMatchObject({
      changed: ['title'],
    });
  });

  it.each(['uploading', 'uploaded', 'cleaning', 'transcribing', 'analyzing', 'failed'] as const)(
    'refuses edits while a sermon is %s',
    async (status) => {
      const owner = await insertUser(db, 'contributor');
      const s = await sermonFor(owner, status);
      await rejects(updateDetails(db, owner, s.id, { title: 'x' }), 'conflict');
      await rejects(addScriptureRef(db, owner, s.id, ref), 'conflict');
    },
  );

  it('treats a deleted sermon as missing', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await sermonFor(owner, 'needs_review', { deletedAt: new Date() });
    await rejects(updateDetails(db, admin, s.id, { title: 'x' }), 'not_found');
  });
});

describe('updateDetails', () => {
  it('saves the fields, records a manual date, and audits exactly what changed', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner, { recordedOn: null });
    const result = await updateDetails(db, owner, s.id, {
      title: ' Trusting the Watchmen ',
      speaker: 'Pastor Lee',
      recordedOn: '3/13/1988',
    });
    expect(result.changed.sort()).toEqual(['recordedOn', 'speaker', 'title']);
    expect(await get(s.id)).toMatchObject({
      title: 'Trusting the Watchmen',
      speaker: 'Pastor Lee',
      recordedOn: '1988-03-13',
      dateSource: 'manual',
    });
    const [entry] = await audits('sermon.update');
    expect(entry).toMatchObject({ actorId: owner.id, entityId: s.id });
    expect(entry.diff).toMatchObject({
      title: { from: 'Submitting to Leaders', to: 'Trusting the Watchmen' },
      recordedOn: { from: null, to: '1988-03-13' },
    });
  });

  it('changes only what it is given, and writes no audit entry when nothing changed', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    await updateDetails(db, owner, s.id, { speaker: 'Pastor Lee' });
    expect((await get(s.id)).title).toBe('Submitting to Leaders');
    await updateDetails(db, owner, s.id, { speaker: 'Pastor Lee', title: 'Submitting to Leaders' });
    expect(await audits('sermon.update')).toHaveLength(1);
  });

  it('turns the main passage into testament, genre and book tags, and flags the matching reference', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner, { primaryPassage: null });
    await db.insert(scriptureRefs).values([
      {
        sermonId: s.id,
        book: 'Romans',
        chapter: 13,
        verseStart: 1,
        verseEnd: 2,
        spokenAtSec: 260,
        source: 'auto',
      },
      {
        sermonId: s.id,
        book: 'Hebrews',
        chapter: 13,
        verseStart: 17,
        spokenAtSec: 1258,
        source: 'auto',
      },
      {
        sermonId: s.id,
        book: 'Hebrews',
        chapter: 13,
        verseStart: 17,
        spokenAtSec: 2000,
        source: 'auto',
      },
    ]);
    await updateDetails(db, owner, s.id, { primaryPassage: 'Hebrews 13:17' });
    expect((await get(s.id)).primaryPassage).toEqual({
      book: 'Hebrews',
      chapter: 13,
      verseStart: 17,
      verseEnd: null,
    });
    expect(await tagNames(s.id)).toEqual([
      'book:Hebrews',
      'genre:Epistle',
      'testament:New Testament',
    ]);
    const flagged = await db.select().from(scriptureRefs).where(eq(scriptureRefs.isMainText, true));
    expect(flagged).toHaveLength(1);
    expect(flagged[0].spokenAtSec).toBe(1258); // the first time it was spoken
    await updateDetails(db, owner, s.id, { primaryPassage: 'Romans 13:1-2' });
    expect(await tagNames(s.id)).toEqual([
      'book:Romans',
      'genre:Epistle',
      'testament:New Testament',
    ]);
  });

  it('keeps topic tags separate, removes duplicates, and leaves passage tags alone', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner, { primaryPassage: null });
    await updateDetails(db, owner, s.id, { primaryPassage: 'Hebrews 13:17' });
    await updateDetails(db, owner, s.id, {
      topics: ['Church leadership', 'church leadership', 'Trust'],
    });
    expect(await tagNames(s.id)).toEqual([
      'book:Hebrews',
      'genre:Epistle',
      'testament:New Testament',
      'topic:Church leadership',
      'topic:Trust',
    ]);
    await updateDetails(db, owner, s.id, { topics: ['Trust'] });
    expect((await tagNames(s.id)).filter((t) => t.startsWith('topic:'))).toEqual(['topic:Trust']);
    expect((await tagNames(s.id)).length).toBe(4);
  });

  it('reuses an existing topic tag whatever its capitalisation', async () => {
    const a = await insertUser(db, 'contributor');
    const s1 = await readySermon(a);
    const s2 = await readySermon(a);
    await updateDetails(db, a, s1.id, { topics: ['Church leadership'] });
    await updateDetails(db, a, s2.id, { topics: ['church LEADERSHIP'] });
    expect(await db.select().from(tags).where(eq(tags.kind, 'topic'))).toHaveLength(1);
  });

  it('clears the date and the main passage when given blanks', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    await updateDetails(db, owner, s.id, { recordedOn: '', primaryPassage: '' });
    expect(await get(s.id)).toMatchObject({
      recordedOn: null,
      dateSource: null,
      primaryPassage: null,
    });
    expect(await tagNames(s.id)).toEqual([]);
  });

  it.each([
    [{ recordedOn: '02/30/1988' }, 'recordedOn'],
    [{ recordedOn: 'March' }, 'recordedOn'],
    [{ primaryPassage: 'Romans 99:1' }, 'primaryPassage'],
    [{ primaryPassage: 'Hezekiah 3:1' }, 'primaryPassage'],
    [{ title: 'x'.repeat(81) }, 'title'],
    [{ topics: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'topics'],
    [{ topics: ['x'.repeat(41)] }, 'topics'],
  ])('rejects %j and saves nothing', async (input, field) => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    await rejects(
      updateDetails(db, owner, s.id, { title: 'Would be saved', ...input }),
      'invalid',
      field,
    );
    expect((await get(s.id)).title).toBe('Submitting to Leaders');
    expect(await audits('sermon.update')).toHaveLength(0);
  });
});

describe('summary', () => {
  it('saves an edit as edited, and audits it', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner, { summaryText: 'Auto text.', summarySource: 'auto' });
    await saveSummary(db, owner, s.id, '  A better summary.  ');
    expect(await get(s.id)).toMatchObject({
      summaryText: 'A better summary.',
      summarySource: 'edited',
    });
    expect((await audits('sermon.summary_edit'))[0].diff).toEqual({
      from: 'Auto text.',
      to: 'A better summary.',
    });
  });

  it('does nothing, and does not mark the summary edited, when it is unchanged', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner, { summaryText: 'Same.', summarySource: 'auto' });
    await saveSummary(db, owner, s.id, 'Same.');
    expect((await get(s.id)).summarySource).toBe('auto');
    expect(await audits('sermon.summary_edit')).toHaveLength(0);
  });

  it('rejects an over-long summary', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    await rejects(saveSummary(db, owner, s.id, 'x'.repeat(2001)), 'invalid', 'summary');
  });
});

describe('requestRegenerate', () => {
  it('sends the sermon back for a new summary and queues an analysis limited to it', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    await requestRegenerate(db, owner, s.id);
    expect((await get(s.id)).status).toBe('analyzing');
    expect(await db.select().from(jobs).where(eq(jobs.sermonId, s.id))).toMatchObject([
      { type: 'analyze', state: 'queued', payload: { only: 'summary' } },
    ]);
    expect(await audits('sermon.regenerate')).toHaveLength(1);
  });

  it('cannot be pressed twice, or on an approved sermon', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await readySermon(owner);
    await requestRegenerate(db, owner, s.id);
    await rejects(requestRegenerate(db, owner, s.id), 'conflict');
    const approved = await sermonFor(owner, 'approved');
    await rejects(requestRegenerate(db, admin, approved.id), 'conflict');
  });

  it('when pressed several times at once, queues one job', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => requestRegenerate(db, owner, s.id)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.sermonId, s.id))).toHaveLength(1);
  });
});

describe('scripture references', () => {
  it('adds a passage the system missed, as a manual entry, and audits it', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    const added = await addScriptureRef(db, owner, s.id, { ...ref, book: 'heb' });
    expect(added).toMatchObject({
      book: 'Hebrews',
      chapter: 13,
      verseStart: 17,
      source: 'manual',
      editedBy: owner.id,
      detectedOriginal: null,
    });
    expect((await audits('scripture.add'))[0].diff).toMatchObject({
      ref: 'Hebrews 13:17',
      spokenAtSec: 1258,
    });
  });

  it.each([
    [{ book: 'Hezekiah' }, 'book'],
    [{ chapter: 99 }, 'chapter'],
    [{ verseStart: 99 }, 'verseStart'],
    [{ verseStart: 17, verseEnd: 12 }, 'verseEnd'],
    [{ spokenAtSec: -1 }, 'spokenAtSec'],
    [{ spokenAtSec: 5000 }, 'spokenAtSec'],
    [{ chapter: 'thirteen' }, 'chapter'],
  ])('rejects %j', async (change, field) => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    await rejects(addScriptureRef(db, owner, s.id, { ...ref, ...change }), 'invalid', field);
    expect(await db.select().from(scriptureRefs)).toHaveLength(0);
  });

  it('refuses a passage that is already in the list, and says where', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    await addScriptureRef(db, owner, s.id, ref);
    const error = await rejects(
      addScriptureRef(db, owner, s.id, { ...ref, spokenAtSec: 2000 }),
      'invalid',
      'book',
    );
    expect(error.message).toBe('Hebrews 13:17 is already in the list, at 20:58.');
    expect(await db.select().from(scriptureRefs)).toHaveLength(1);
  });

  it('treats a different verse, range or whole chapter as a different passage', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    await addScriptureRef(db, owner, s.id, ref);
    await addScriptureRef(db, owner, s.id, { ...ref, verseStart: 7 });
    await addScriptureRef(db, owner, s.id, { ...ref, verseStart: 17, verseEnd: 19 });
    await addScriptureRef(db, owner, s.id, { ...ref, verseStart: null });
    expect(await db.select().from(scriptureRefs)).toHaveLength(4);
  });

  it('lets a deleted passage be added again', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    const first = await addScriptureRef(db, owner, s.id, ref);
    await deleteScriptureRef(db, owner, s.id, first.id);
    await expect(addScriptureRef(db, owner, s.id, ref)).resolves.toMatchObject({ book: 'Hebrews' });
  });

  it('refuses to edit a passage into one already listed, but lets it keep itself', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    await addScriptureRef(db, owner, s.id, ref);
    const other = await addScriptureRef(db, owner, s.id, { ...ref, verseStart: 7 });
    await rejects(editScriptureRef(db, owner, s.id, other.id, ref), 'invalid', 'book');
    await expect(
      editScriptureRef(db, owner, s.id, other.id, {
        ...ref,
        verseStart: 7,
        contextNote: 'new note',
      }),
    ).resolves.toBeUndefined();
  });

  it('marking a new passage as the main text makes it the sermon’s main passage and tags', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner, { primaryPassage: null });
    await addScriptureRef(db, owner, s.id, { ...ref, isMainText: true });
    expect((await get(s.id)).primaryPassage).toMatchObject({ book: 'Hebrews', chapter: 13 });
    expect((await db.select().from(scriptureRefs))[0].isMainText).toBe(true);
    expect(await tagNames(s.id)).toContain('book:Hebrews');
  });

  it('editing keeps what the system found, records who changed it, and audits before and after', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    const [auto] = await db
      .insert(scriptureRefs)
      .values({
        sermonId: s.id,
        book: 'Hebrews',
        chapter: 13,
        verseStart: 7,
        spokenAtSec: 1212,
        source: 'auto',
        detectedOriginal: { book: 'Hebrews', chapter: 13, verseStart: 7, verseEnd: null },
      })
      .returning();
    await editScriptureRef(db, owner, s.id, auto.id, { ...ref, verseStart: 17, spokenAtSec: 1258 });
    const [after] = await db.select().from(scriptureRefs);
    expect(after).toMatchObject({
      verseStart: 17,
      source: 'auto',
      editedBy: owner.id,
      spokenAtSec: 1258,
    });
    expect(after.detectedOriginal).toEqual({
      book: 'Hebrews',
      chapter: 13,
      verseStart: 7,
      verseEnd: null,
    });
    expect(after.editedAt).not.toBeNull();
    expect((await audits('scripture.edit'))[0].diff).toMatchObject({
      from: { ref: 'Hebrews 13:7' },
      to: { ref: 'Hebrews 13:17' },
    });
  });

  it('editing the main text follows the change; unticking it clears the main passage', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    const main = await addScriptureRef(db, owner, s.id, { ...ref, isMainText: true });
    await editScriptureRef(db, owner, s.id, main.id, { ...ref, verseStart: 18, isMainText: true });
    expect((await get(s.id)).primaryPassage).toMatchObject({ verseStart: 18 });
    await editScriptureRef(db, owner, s.id, main.id, { ...ref, verseStart: 18, isMainText: false });
    expect((await get(s.id)).primaryPassage).toBeNull();
    expect((await db.select().from(scriptureRefs))[0].isMainText).toBe(false);
  });

  it('deleting hides the passage, keeps it on record, and audits it', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    const added = await addScriptureRef(db, owner, s.id, ref);
    await deleteScriptureRef(db, owner, s.id, added.id);
    const [row] = await db.select().from(scriptureRefs);
    expect(row.deletedAt).not.toBeNull();
    expect((await audits('scripture.delete'))[0].diff).toMatchObject({
      ref: 'Hebrews 13:17',
      source: 'manual',
    });
    await rejects(deleteScriptureRef(db, owner, s.id, added.id), 'not_found');
    await rejects(editScriptureRef(db, owner, s.id, added.id, ref), 'not_found');
  });

  it('cannot reach a passage that belongs to another sermon', async () => {
    const owner = await insertUser(db, 'contributor');
    const a = await readySermon(owner);
    const b = await readySermon(owner);
    const added = await addScriptureRef(db, owner, a.id, ref);
    await rejects(deleteScriptureRef(db, owner, b.id, added.id), 'not_found');
    await rejects(editScriptureRef(db, owner, b.id, added.id, ref), 'not_found');
    expect((await db.select().from(scriptureRefs))[0].deletedAt).toBeNull();
  });
});

describe('approval', () => {
  it('approves, names the file the way the mockups do, and records who and when', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await readySermon(owner);
    expect(await approveSermon(db, owner, s.id)).toEqual({
      stem: '1988-03-13_Hebrews-13-17_Submitting-to-Leaders',
    });
    expect(await get(s.id)).toMatchObject({
      status: 'approved',
      filenameStem: '1988-03-13_Hebrews-13-17_Submitting-to-Leaders',
      approvedBy: owner.id,
    });
    expect((await get(s.id)).approvedAt).not.toBeNull();
    expect((await audits('sermon.approve'))[0]).toMatchObject({
      actorId: owner.id,
      entityId: s.id,
    });
  });

  it('lists everything still missing, and approves nothing', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await sermonFor(owner, 'needs_review', { title: null });
    const error = await rejects(approveSermon(db, owner, s.id), 'invalid');
    expect(Object.keys(error.fieldErrors ?? {}).sort()).toEqual([
      'primaryPassage',
      'recordedOn',
      'title',
    ]);
    expect((await get(s.id)).status).toBe('needs_review');
    expect(await audits('sermon.approve')).toHaveLength(0);
  });

  it('approvalProblems is what the button uses to decide', () => {
    expect(
      approvalProblems({
        title: 'x',
        recordedOn: '1988-03-13',
        primaryPassage: { book: 'John', chapter: 3 },
      }),
    ).toEqual({});
    expect(
      Object.keys(approvalProblems({ title: '  ', recordedOn: null, primaryPassage: null })),
    ).toEqual(['recordedOn', 'primaryPassage', 'title']);
  });

  it('gives a second sermon with the same name the suffix _2', async () => {
    const owner = await insertUser(db, 'contributor');
    const a = await readySermon(owner);
    const b = await readySermon(owner);
    await approveSermon(db, owner, a.id);
    expect((await approveSermon(db, owner, b.id)).stem).toBe(
      '1988-03-13_Hebrews-13-17_Submitting-to-Leaders_2',
    );
  });

  it('gives two sermons approved at the same moment two different names', async () => {
    const owner = await insertUser(db, 'contributor');
    const a = await readySermon(owner);
    const b = await readySermon(owner);
    const [x, y] = await Promise.all([
      approveSermon(db, owner, a.id),
      approveSermon(db, owner, b.id),
    ]);
    expect(new Set([x.stem, y.stem]).size).toBe(2);
  });

  it('lets an admin approve anyone’s sermon but not another contributor’s', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await readySermon(owner);
    await rejects(approveSermon(db, other, s.id), 'not_found');
    await expect(approveSermon(db, admin, s.id)).resolves.toHaveProperty('stem');
  });

  it('cannot approve twice, or a sermon still being processed, or as a viewer', async () => {
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const s = await readySermon(owner);
    await approveSermon(db, owner, s.id);
    await rejects(approveSermon(db, owner, s.id), 'conflict');
    const analyzing = await sermonFor(owner, 'analyzing', {
      recordedOn: '1988-03-13',
      primaryPassage: { book: 'John', chapter: 3 },
    });
    await rejects(approveSermon(db, owner, analyzing.id), 'conflict');
    await rejects(approveSermon(db, viewer, s.id), 'forbidden');
  });

  it('freezes the file name at approval, so later details do not change it here', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await readySermon(owner);
    await approveSermon(db, owner, s.id);
    await updateDetails(db, admin, s.id, { title: 'A New Title' });
    expect((await get(s.id)).filenameStem).toBe('1988-03-13_Hebrews-13-17_Submitting-to-Leaders');
  });

  it('a sermon approved with the same filename as a deleted one is not suffixed', async () => {
    const owner = await insertUser(db, 'contributor');
    const a = await readySermon(owner);
    await approveSermon(db, owner, a.id);
    await db
      .update(sermons)
      .set({ deletedAt: new Date() })
      .where(and(eq(sermons.id, a.id)));
    const b = await readySermon(owner);
    expect((await approveSermon(db, owner, b.id)).stem).toBe(
      '1988-03-13_Hebrews-13-17_Submitting-to-Leaders',
    );
  });
});
