import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeUploadStore } from '@/adapters/uploads/fake';
import {
  audioAssets,
  auditLog,
  jobs,
  scriptureRefs,
  sermons,
  transcripts,
  uploads,
} from '@/db/schema';
import { getSermonDetail } from '@/lib/sermons/detail';
import type { SermonStatus } from '@/lib/sermon-status';
import {
  abortUpload,
  completeUpload,
  listQueue,
  presignPartUrl,
  startUpload,
  UploadError,
} from '@/lib/uploads/service';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import { putPart, tempStore, wavBytes } from '../../../tests/support/uploads';
import { rejectAudio, ReviewError } from './service';

const db = openTestDb();
const PART = 16;
let store: FakeUploadStore;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  await resetTables(db);
  ({ store, cleanup } = await tempStore(1));
});
afterEach(() => cleanup());
afterAll(() => db.close());

type User = Awaited<ReturnType<typeof insertUser>>;
const deps = () => ({ db, store, partSize: PART });
const get = async (id: string) => (await db.select().from(sermons).where(eq(sermons.id, id)))[0];
const REASON = 'The recording stops partway through the sermon.';

async function upload(user: User, over: Record<string, unknown> = {}, bytes = wavBytes(40)) {
  const started = await startUpload(deps(), user, {
    filename: 'Tape14_SideA.wav',
    sizeBytes: bytes.length,
    lastModified: 1_700_000_000_000,
    ...over,
  });
  for (let n = 1; n <= started.totalParts; n++) {
    const { url } = await presignPartUrl(deps(), user, started.uploadId, n);
    await putPart(store, url, bytes.slice((n - 1) * PART, n * PART));
  }
  return started;
}

/** An uploaded sermon that the worker has processed: cleaned, transcribed, one passage found. */
async function processed(owner: User, status: SermonStatus = 'needs_review') {
  const { uploadId, sermonId } = await upload(owner, {
    details: { recordedOn: '03/13/1988', labelScripture: 'Hebrews 13:17' },
  });
  await completeUpload(deps(), owner, uploadId);
  await db.update(jobs).set({ state: 'succeeded' }).where(eq(jobs.sermonId, sermonId));
  await db.insert(audioAssets).values({
    sermonId,
    kind: 'cleaned',
    storageKey: `cleaned/${sermonId}/job.mp3`,
    sha256: 'x',
    bytes: 1,
    mime: 'audio/mpeg',
    originalFilename: 'cleaned.mp3',
  });
  await db.insert(transcripts).values({
    sermonId,
    version: 1,
    model: 'fake',
    language: 'en',
    fullText: 'Turn to Hebrews',
    segments: [],
    lowConfidence: [],
  });
  await db.insert(scriptureRefs).values({
    sermonId,
    book: 'Hebrews',
    chapter: 13,
    verseStart: 17,
    spokenAtSec: 12,
    source: 'manual',
  });
  await db
    .update(sermons)
    .set({ status, title: 'Submitting to Leaders', durationSec: 600 })
    .where(eq(sermons.id, sermonId));
  return sermonId;
}

const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(ReviewError);
  expect((error as ReviewError).code).toBe(code);
};

describe('rejectAudio', () => {
  it('sets the recording aside, keeps the files and details, and waits for the full one', async () => {
    const owner = await insertUser(db, 'contributor');
    const id = await processed(owner);

    await rejectAudio(db, owner, id, { reason: `  ${REASON}  ` });

    expect(await get(id)).toMatchObject({
      status: 'needs_audio',
      audioRejectedReason: REASON,
      durationSec: null,
      title: 'Submitting to Leaders',
      recordedOn: '1988-03-13',
      labelScripture: 'Hebrews 13:17',
      deletedAt: null,
    });
    const assets = await db.select().from(audioAssets).where(eq(audioAssets.sermonId, id));
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.setAsideAt !== null)).toBe(true);
    // The file itself is still in storage.
    const original = assets.find((a) => a.kind === 'original')!;
    expect((await store.head(original.storageKey))?.bytes).toBe(40);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'sermon.audio_rejected'));
    expect(entry).toMatchObject({ actorId: owner.id, entityId: id });
    expect(entry.diff).toMatchObject({ reason: REASON, from: 'needs_review' });
  });

  it('hides the rejected audio and its transcript on the sermon page', async () => {
    const owner = await insertUser(db, 'contributor');
    const id = await processed(owner);
    await rejectAudio(db, owner, id, { reason: REASON });
    const detail = await getSermonDetail(db, owner, id);
    expect(detail).toMatchObject({
      status: 'needs_audio',
      audioRejectedReason: REASON,
      original: null,
      cleaned: null,
      transcript: null,
      canRejectAudio: false,
      canReplaceAudio: true,
      canEdit: false,
    });
  });

  it('works for a sermon whose processing failed, and clears the failure', async () => {
    const owner = await insertUser(db, 'contributor');
    const id = await processed(owner, 'failed');
    await db
      .update(sermons)
      .set({ failedStage: 'transcribing', lastError: 'No speech found.' })
      .where(eq(sermons.id, id));
    await rejectAudio(db, owner, id, { reason: REASON });
    expect(await get(id)).toMatchObject({
      status: 'needs_audio',
      failedStage: null,
      lastError: null,
    });
  });

  it('lets an admin reject anyone’s, and hides it from other contributors', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const admin = await insertUser(db, 'admin');
    const id = await processed(owner);
    await rejectsWith(rejectAudio(db, other, id, { reason: REASON }), 'not_found');
    await expect(rejectAudio(db, viewer, id, { reason: REASON })).rejects.toThrow();
    await rejectAudio(db, admin, id, { reason: REASON });
    expect((await get(id)).status).toBe('needs_audio');
  });

  it.each(['approved', 'filed', 'transcribing', 'needs_audio'] as const)(
    'refuses a sermon that is %s',
    async (status) => {
      const owner = await insertUser(db, 'admin');
      const id = await processed(owner, status);
      await rejectsWith(rejectAudio(db, owner, id, { reason: REASON }), 'conflict');
      expect((await get(id)).status).toBe(status);
    },
  );

  it.each([[''], ['   '], ['x'.repeat(301)]])('needs a short reason (%j)', async (reason) => {
    const owner = await insertUser(db, 'contributor');
    const id = await processed(owner);
    await rejectsWith(rejectAudio(db, owner, id, { reason }), 'invalid');
    expect((await get(id)).status).toBe('needs_review');
  });
});

describe('uploading the full recording', () => {
  async function rejected(owner: User) {
    const id = await processed(owner);
    await rejectAudio(db, owner, id, { reason: REASON });
    return id;
  }

  it('adds a new original next to the rejected one and starts processing again', async () => {
    const owner = await insertUser(db, 'contributor');
    const id = await rejected(owner);
    const full = wavBytes(56);

    const started = await upload(
      owner,
      { filename: 'Tape14_SideA_full.wav', replacesSermonId: id },
      full,
    );
    expect(started.sermonId).toBe(id);
    expect((await get(id)).status).toBe('needs_audio');
    expect(await completeUpload(deps(), owner, started.uploadId)).toEqual({
      sermonId: id,
      status: 'uploaded',
    });

    expect(await get(id)).toMatchObject({
      status: 'uploaded',
      audioRejectedReason: null,
      durationSec: null,
      title: 'Submitting to Leaders',
      recordedOn: '1988-03-13',
    });
    const originals = await db
      .select()
      .from(audioAssets)
      .where(and(eq(audioAssets.sermonId, id), eq(audioAssets.kind, 'original')));
    expect(originals).toHaveLength(2);
    const current = originals.find((a) => a.setAsideAt === null)!;
    const old = originals.find((a) => a.setAsideAt !== null)!;
    expect(current).toMatchObject({ originalFilename: 'Tape14_SideA_full.wav', bytes: 56 });
    expect(current.storageKey).not.toBe(old.storageKey);
    expect((await store.head(old.storageKey))?.bytes).toBe(40);
    expect(
      await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.sermonId, id), eq(jobs.state, 'queued'))),
    ).toMatchObject([{ type: 'clean' }]);
    // The passage a person added is still there for review.
    expect(
      await db
        .select()
        .from(scriptureRefs)
        .where(and(eq(scriptureRefs.sermonId, id), isNull(scriptureRefs.deletedAt))),
    ).toHaveLength(1);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, 'sermon.audio_replaced')),
    ).toHaveLength(1);
    const detail = await getSermonDetail(db, owner, id);
    expect(detail?.filename).toBe('Tape14_SideA_full.wav');
  });

  it('lets an admin upload it for someone else’s sermon', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const id = await rejected(owner);
    const { uploadId } = await upload(admin, { replacesSermonId: id });
    await completeUpload(deps(), admin, uploadId);
    expect((await get(id)).status).toBe('uploaded');
  });

  it('refuses another contributor, and a sermon that is not waiting for one', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const id = await rejected(owner);
    await expect(upload(other, { replacesSermonId: id })).rejects.toMatchObject({
      code: 'not_found',
    });
    const fine = await processed(owner);
    await expect(upload(owner, { replacesSermonId: fine })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await db.select().from(uploads).where(eq(uploads.replacesAudio, true))).toHaveLength(0);
  });

  it('keeps the sermon waiting when the replacement is cancelled or isn’t audio', async () => {
    const owner = await insertUser(db, 'contributor');
    const id = await rejected(owner);

    const cancelled = await startUpload(deps(), owner, {
      filename: 'full.wav',
      sizeBytes: 40,
      lastModified: 2,
      replacesSermonId: id,
    });
    await abortUpload(deps(), owner, cancelled.uploadId);
    expect(await get(id)).toMatchObject({ status: 'needs_audio', deletedAt: null });

    const junk = new Uint8Array(40).fill(7);
    const { uploadId } = await upload(owner, { filename: 'junk.wav', replacesSermonId: id }, junk);
    const error = await completeUpload(deps(), owner, uploadId).catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).code).toBe('not_audio');
    expect(await get(id)).toMatchObject({ status: 'needs_audio', deletedAt: null });
  });

  it('accepts only one replacement when two finish', async () => {
    const owner = await insertUser(db, 'contributor');
    const id = await rejected(owner);
    const first = await upload(owner, { filename: 'a.wav', replacesSermonId: id });
    const second = await upload(owner, { filename: 'b.wav', replacesSermonId: id });
    await completeUpload(deps(), owner, first.uploadId);
    const error = await completeUpload(deps(), owner, second.uploadId).catch((e) => e);
    expect((error as UploadError).code).toBe('conflict');
    const live = await db
      .select()
      .from(audioAssets)
      .where(
        and(
          eq(audioAssets.sermonId, id),
          eq(audioAssets.kind, 'original'),
          isNull(audioAssets.setAsideAt),
        ),
      );
    expect(live).toMatchObject([{ originalFilename: 'a.wav' }]);
  });

  it('does not resume an upload of the same file meant for a different sermon', async () => {
    const owner = await insertUser(db, 'contributor');
    const id = await rejected(owner);
    const fresh = await startUpload(deps(), owner, {
      filename: 'same.wav',
      sizeBytes: 40,
      lastModified: 5,
    });
    const replacement = await startUpload(deps(), owner, {
      filename: 'same.wav',
      sizeBytes: 40,
      lastModified: 5,
      replacesSermonId: id,
    });
    expect(replacement.resumed).toBe(false);
    expect(replacement.sermonId).toBe(id);
    expect(replacement.uploadId).not.toBe(fresh.uploadId);
  });

  it('lists the sermon once in the queue, by its first file name', async () => {
    const owner = await insertUser(db, 'contributor');
    const id = await rejected(owner);
    await upload(owner, { filename: 'full.wav', replacesSermonId: id });
    const rows = (await listQueue(db, owner)).filter((r) => r.sermonId === id);
    expect(rows).toMatchObject([{ status: 'needs_audio', filename: 'Tape14_SideA.wav' }]);
  });
});
