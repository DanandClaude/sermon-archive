import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { audioAssets, scriptureRefs, sermons, transcripts } from '@/db/schema';
import { ForbiddenError } from '@/lib/errors';
import type { Actor } from '@/lib/permissions';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import { disconnectChannel, DistributionError, saveLibrarySettings } from './channels';
import {
  findLibraryAudio,
  getLibraryInfo,
  getLibrarySermon,
  listLibrary,
  matchesSearch,
  type LibraryEntry,
} from './library';
import { getPublishPreview, requestPublish, requestUnpublish } from './publications';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

const LIBRARY = { title: 'Grace Church Sermons', description: 'Listen any time.' };

async function sermon(
  owner: { id: string },
  over: Partial<typeof sermons.$inferInsert> = {},
  options: { audio?: boolean } = {},
) {
  const [s] = await db
    .insert(sermons)
    .values({
      contributorId: owner.id,
      status: 'approved',
      title: 'Submitting to Leaders',
      recordedOn: '1988-03-13',
      summaryText: 'On obeying those who watch for your souls.',
      filenameStem: `stem-${crypto.randomUUID()}`,
      primaryPassage: { book: 'Hebrews', chapter: 13, verseStart: 17, verseEnd: null },
      approvedAt: new Date(),
      ...over,
    })
    .returning();
  if (options.audio ?? true) {
    await db.insert(audioAssets).values({
      sermonId: s.id,
      kind: 'cleaned',
      storageKey: `cleaned/${s.id}.mp3`,
      sha256: 'x',
      bytes: 4321,
      mime: 'audio/mpeg',
      originalFilename: 'side-a.mp3',
      durationSec: 1800,
    });
  }
  await db.insert(scriptureRefs).values({
    sermonId: s.id,
    book: 'Hebrews',
    chapter: 13,
    verseStart: 17,
    spokenAtSec: 754,
    isMainText: true,
    source: 'manual',
  });
  await db.insert(transcripts).values({
    sermonId: s.id,
    version: 1,
    model: 'fake',
    language: 'en',
    fullText: 'Turn with me to Hebrews.',
    segments: [{ start: 0, end: 2, text: 'Turn with me to Hebrews.', words: [] }],
    lowConfidence: [],
  });
  return s;
}

async function setup() {
  const admin = await insertUser(db, 'admin');
  await saveLibrarySettings(db, admin, LIBRARY);
  return admin;
}

const publish = (admin: Actor, id: string) => requestPublish(db, admin, id, { channel: 'library' });

describe('online library', () => {
  it('shows a sermon at once when an admin publishes it, with its passages and transcript', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const pub = await publish(admin, s.id);
    expect(pub.state).toBe('published');
    expect(pub.visibility).toBe('public');

    const library = await listLibrary(db);
    expect(library?.info).toMatchObject(LIBRARY);
    expect(library?.entries.map((e) => e.id)).toEqual([pub.id]);
    expect(library?.entries[0]).toMatchObject({
      title: 'Submitting to Leaders',
      passage: 'Hebrews 13:17',
      durationSec: null,
    });

    const page = await getLibrarySermon(db, pub.id);
    expect(page?.passages).toEqual([
      { label: 'Hebrews 13:17', spokenAtSec: 754, isMainText: true },
    ]);
    expect(page?.segments[0].text).toBe('Turn with me to Hebrews.');
    expect(await findLibraryAudio(db, pub.id)).toBe(`cleaned/${s.id}.mp3`);
  });

  it('is addressed by publication id, never by sermon id', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    await publish(admin, s.id);
    expect(await getLibrarySermon(db, s.id)).toBeNull();
    expect(await findLibraryAudio(db, s.id)).toBeNull();
  });

  it('never shows a sermon that was not published to it', async () => {
    const admin = await setup();
    await publish(admin, (await sermon(admin)).id);
    await sermon(admin, { title: 'Never published' });
    const library = await listLibrary(db);
    expect(library?.entries.map((e) => e.title)).toEqual(['Submitting to Leaders']);
    expect(library?.total).toBe(1);
  });

  it('never plays a recording that was set aside', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const pub = await publish(admin, s.id);
    await db
      .update(audioAssets)
      .set({ setAsideAt: new Date() })
      .where(eq(audioAssets.sermonId, s.id));
    expect(await findLibraryAudio(db, pub.id)).toBeNull();
    expect(await getLibrarySermon(db, pub.id)).toBeNull();
  });

  it('drops a sermon the moment it is unpublished, and brings it back if published again', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const pub = await publish(admin, s.id);
    await requestUnpublish(db, admin, pub.id);
    expect((await listLibrary(db))?.entries).toEqual([]);
    expect(await getLibrarySermon(db, pub.id)).toBeNull();
    expect(await findLibraryAudio(db, pub.id)).toBeNull();

    await publish(admin, s.id);
    expect(await getLibrarySermon(db, pub.id)).not.toBeNull();
  });

  it('hides a sermon that is later deleted or sent back to review', async () => {
    const admin = await setup();
    const a = await sermon(admin);
    const b = await sermon(admin);
    const pa = await publish(admin, a.id);
    const pb = await publish(admin, b.id);
    await db.update(sermons).set({ deletedAt: new Date() }).where(eq(sermons.id, a.id));
    await db.update(sermons).set({ status: 'needs_review' }).where(eq(sermons.id, b.id));
    for (const id of [pa.id, pb.id]) {
      expect(await getLibrarySermon(db, id)).toBeNull();
      expect(await findLibraryAudio(db, id)).toBeNull();
    }
    expect((await listLibrary(db))?.entries).toEqual([]);
  });

  it('shows nothing at all while the library is turned off, and everything again when it is back', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const pub = await publish(admin, s.id);
    await disconnectChannel(db, admin, 'library');
    expect(await getLibraryInfo(db)).toBeNull();
    expect(await listLibrary(db)).toBeNull();
    expect(await getLibrarySermon(db, pub.id)).toBeNull();
    expect(await findLibraryAudio(db, pub.id)).toBeNull();

    await saveLibrarySettings(db, admin, LIBRARY);
    expect(await getLibrarySermon(db, pub.id)).not.toBeNull();
  });

  it('can only be published to once it is turned on, and only with a cleaned recording', async () => {
    const admin = await insertUser(db, 'admin');
    const s = await sermon(admin);
    const off = await publish(admin, s.id).catch((e) => e);
    expect(off).toBeInstanceOf(DistributionError);
    expect((off as DistributionError).message).toMatch(/turn on the online library/i);

    await saveLibrarySettings(db, admin, LIBRARY);
    const silent = await sermon(admin, {}, { audio: false });
    const noAudio = await publish(admin, silent.id).catch((e) => e);
    expect((noAudio as DistributionError).code).toBe('conflict');
  });

  it('refuses drafts', async () => {
    const admin = await setup();
    const draft = await sermon(admin, { status: 'needs_review', approvedAt: null });
    const error = await publish(admin, draft.id).catch((e) => e);
    expect((error as DistributionError).code).toBe('conflict');
    expect((await listLibrary(db))?.total).toBe(0);
  });

  it('lets only admins publish to it or change it', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    for (const role of ['contributor', 'viewer'] as const) {
      const user = await insertUser(db, role);
      await expect(requestPublish(db, user, s.id, { channel: 'library' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(saveLibrarySettings(db, user, LIBRARY)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(disconnectChannel(db, user, 'library')).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('is offered in the publish dialog once turned on', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const preview = await getPublishPreview(db, admin, s.id);
    expect(preview?.channels.find((c) => c.kind === 'library')).toMatchObject({
      connected: true,
      defaultVisibility: 'public',
      publication: null,
    });
  });

  it('checks the library name', async () => {
    const admin = await insertUser(db, 'admin');
    const error = await saveLibrarySettings(db, admin, { title: ' ', description: '' }).catch(
      (e) => e,
    );
    expect((error as DistributionError).fieldErrors?.title).toBeTruthy();
  });
});

describe('library search', () => {
  const entry: LibraryEntry = {
    id: 'x',
    title: 'Submitting to Leaders',
    recordedOn: '1988-03-13',
    speaker: 'Pastor Hale',
    passage: 'Hebrews 13:17',
    passages: ['Hebrews 13:17', '1 Peter 5:5'],
    durationSec: 1800,
    summary: null,
    publishedAt: new Date(),
  };

  it.each([
    ['', true],
    ['leaders', true],
    ['HEBREWS', true],
    ['1 peter', true],
    ['1988', true],
    ['hebrews 1988', true],
    ['hale', true],
    ['romans', false],
    ['leaders 1990', false],
  ])('%j matches: %s', (query, expected) => {
    expect(matchesSearch(entry, query)).toBe(expected);
  });
});
