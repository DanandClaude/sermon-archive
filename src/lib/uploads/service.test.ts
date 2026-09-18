import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeUploadStore } from '@/adapters/uploads/fake';
import { audioAssets, auditLog, jobs, sermons, uploads } from '@/db/schema';
import { ForbiddenError } from '@/lib/errors';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import { putPart, tempStore, wavBytes } from '../../../tests/support/uploads';
import {
  abortUpload,
  completeUpload,
  listQueue,
  presignPartUrl,
  startUpload,
  UploadError,
} from './service';

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

const deps = () => ({ db, store, partSize: PART });
const file = (over: Record<string, unknown> = {}) => ({
  filename: 'Tape14_SideA.wav',
  sizeBytes: 40,
  lastModified: 1_700_000_000_000,
  ...over,
});

/** Sends parts 1..N (or just the listed ones) the way the browser would. */
async function sendParts(
  actor: { id: string; role: 'contributor' | 'admin' | 'viewer' },
  uploadId: string,
  bytes: Uint8Array,
  only?: number[],
) {
  const total = Math.ceil(bytes.length / PART);
  for (let n = 1; n <= total; n++) {
    if (only && !only.includes(n)) continue;
    const { url } = await presignPartUrl(deps(), actor, uploadId, n);
    await putPart(store, url, bytes.slice((n - 1) * PART, n * PART));
  }
}

const expectUploadError = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(UploadError);
  expect((error as UploadError).code).toBe(code);
  return error as UploadError;
};

describe('startUpload', () => {
  it('creates an uploading sermon with the label details the contributor typed', async () => {
    const user = await insertUser(db, 'contributor');
    const result = await startUpload(deps(), user, {
      ...file(),
      details: {
        recordedOn: '03/13/1988',
        labelScripture: ' Hebrews 13:17 ',
        speaker: 'Pastor Lee',
        batchLabel: 'Box 3',
        side: 'A',
      },
    });
    expect(result).toMatchObject({
      partSize: PART,
      totalParts: 3,
      completedParts: [],
      resumed: false,
    });
    const [sermon] = await db.select().from(sermons).where(eq(sermons.id, result.sermonId));
    expect(sermon).toMatchObject({
      status: 'uploading',
      contributorId: user.id,
      recordedOn: '1988-03-13',
      dateSource: 'label',
      labelScripture: 'Hebrews 13:17',
      speaker: 'Pastor Lee',
      batchLabel: 'Box 3',
      side: 'A',
    });
  });

  it('leaves the date and its source empty when no label date is given', async () => {
    const user = await insertUser(db, 'contributor');
    const result = await startUpload(deps(), user, file());
    const [sermon] = await db.select().from(sermons).where(eq(sermons.id, result.sermonId));
    expect(sermon.recordedOn).toBeNull();
    expect(sermon.dateSource).toBeNull();
  });

  it('is allowed for contributors and admins, and forbidden for viewers', async () => {
    const admin = await insertUser(db, 'admin');
    const viewer = await insertUser(db, 'viewer');
    await expect(startUpload(deps(), admin, file())).resolves.toBeTruthy();
    await expect(startUpload(deps(), viewer, file())).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await db.select().from(sermons).where(eq(sermons.contributorId, viewer.id)),
    ).toHaveLength(0);
  });

  it.each([
    ['an unsupported file type', { filename: 'notes.pdf' }],
    ['a file with no extension', { filename: 'tape' }],
    ['an empty file', { sizeBytes: 0 }],
    ['a file over 2 GB', { sizeBytes: 2 * 1024 * 1024 * 1024 + 1 }],
    ['a file name with a path in it', { filename: '../../etc/tape.wav' }],
    ['a file name with a backslash', { filename: 'a\\b.wav' }],
    ['an impossible label date', { details: { recordedOn: '02/30/1988' } }],
    ['a non-numeric size', { sizeBytes: 'big' }],
  ])('rejects %s and creates nothing', async (_name, over) => {
    const user = await insertUser(db, 'contributor');
    await expectUploadError(startUpload(deps(), user, file(over)), 'invalid');
    expect(await db.select().from(sermons)).toHaveLength(0);
    expect(await db.select().from(uploads)).toHaveLength(0);
  });

  it('reports which field was wrong', async () => {
    const user = await insertUser(db, 'contributor');
    const error = await expectUploadError(
      startUpload(deps(), user, file({ details: { recordedOn: 'sometime in spring' } })),
      'invalid',
    );
    expect(error.fieldErrors).toHaveProperty(['details.recordedOn']);
  });

  it('resumes the same file instead of starting over, reporting the parts already sent', async () => {
    const user = await insertUser(db, 'contributor');
    const bytes = wavBytes(40);
    const first = await startUpload(deps(), user, file());
    await sendParts(user, first.uploadId, bytes, [1, 3]);
    const again = await startUpload(deps(), user, file());
    expect(again).toMatchObject({
      uploadId: first.uploadId,
      sermonId: first.sermonId,
      resumed: true,
    });
    expect(again.completedParts).toEqual([
      { partNumber: 1, size: 16 },
      { partNumber: 3, size: 8 },
    ]);
    expect(await db.select().from(sermons)).toHaveLength(1);
  });

  it('treats a file with a different size or modified time as a new upload', async () => {
    const user = await insertUser(db, 'contributor');
    const a = await startUpload(deps(), user, file());
    const b = await startUpload(deps(), user, file({ lastModified: 1_700_000_000_001 }));
    const c = await startUpload(deps(), user, file({ sizeBytes: 41 }));
    expect(new Set([a.uploadId, b.uploadId, c.uploadId]).size).toBe(3);
  });

  it('does not resume another person’s upload of an identical file', async () => {
    const a = await insertUser(db, 'contributor');
    const b = await insertUser(db, 'contributor');
    const one = await startUpload(deps(), a, file());
    const two = await startUpload(deps(), b, file());
    expect(two.uploadId).not.toBe(one.uploadId);
    expect(two.resumed).toBe(false);
  });

  it('creates one sermon when the same file is started several times at once', async () => {
    const user = await insertUser(db, 'contributor');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => startUpload(deps(), user, file())),
    );
    expect(new Set(results.map((r) => r.uploadId)).size).toBe(1);
    expect(await db.select().from(sermons)).toHaveLength(1);
  });

  it('starts fresh when the storage side of an earlier upload has expired', async () => {
    const user = await insertUser(db, 'contributor');
    const first = await startUpload(deps(), user, file());
    const [row] = await db.select().from(uploads).where(eq(uploads.id, first.uploadId));
    await store.abortMultipartUpload({ key: row.storageKey, uploadId: row.storeUploadId });
    const second = await startUpload(deps(), user, file());
    expect(second.uploadId).not.toBe(first.uploadId);
    expect(second.resumed).toBe(false);
    const [old] = await db.select().from(sermons).where(eq(sermons.id, first.sermonId));
    expect(old.deletedAt).not.toBeNull();
  });
});

describe('presignPartUrl', () => {
  it('only works for the person who started the upload, even for an admin', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const { uploadId } = await startUpload(deps(), owner, file());
    await expect(presignPartUrl(deps(), owner, uploadId, 1)).resolves.toHaveProperty('url');
    await expectUploadError(presignPartUrl(deps(), other, uploadId, 1), 'not_found');
    await expectUploadError(presignPartUrl(deps(), admin, uploadId, 1), 'not_found');
  });

  it.each([0, 4, -1, 1.5, Number.NaN])('rejects part number %s', async (n) => {
    const user = await insertUser(db, 'contributor');
    const { uploadId } = await startUpload(deps(), user, file());
    await expectUploadError(presignPartUrl(deps(), user, uploadId, n), 'not_found');
  });

  it('rejects an unknown upload id and a viewer', async () => {
    const user = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    await expectUploadError(presignPartUrl(deps(), user, crypto.randomUUID(), 1), 'not_found');
    await expect(presignPartUrl(deps(), viewer, crypto.randomUUID(), 1)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('completeUpload', () => {
  it('assembles the file, records its checksum, and moves the sermon to uploaded', async () => {
    const user = await insertUser(db, 'contributor');
    const bytes = wavBytes(40);
    const { uploadId, sermonId } = await startUpload(deps(), user, file());
    await sendParts(user, uploadId, bytes);

    expect(await completeUpload(deps(), user, uploadId)).toEqual({ sermonId, status: 'uploaded' });

    const [sermon] = await db.select().from(sermons).where(eq(sermons.id, sermonId));
    expect(sermon.status).toBe('uploaded');
    const [asset] = await db.select().from(audioAssets).where(eq(audioAssets.sermonId, sermonId));
    expect(asset).toMatchObject({
      kind: 'original',
      bytes: 40,
      mime: 'audio/wav',
      originalFilename: 'Tape14_SideA.wav',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect((await store.head(asset.storageKey))?.bytes).toBe(40);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'sermon.upload'));
    expect(entry).toMatchObject({ actorId: user.id, entityId: sermonId });
  });

  it('queues exactly one cleanup job for the audio worker', async () => {
    const user = await insertUser(db, 'contributor');
    const { uploadId, sermonId } = await startUpload(deps(), user, file());
    await sendParts(user, uploadId, wavBytes(40));
    await completeUpload(deps(), user, uploadId);
    await completeUpload(deps(), user, uploadId);
    expect(await db.select().from(jobs).where(eq(jobs.sermonId, sermonId))).toMatchObject([
      { type: 'clean', state: 'queued' },
    ]);
  });

  it('queues no job when the upload is incomplete or rejected', async () => {
    const user = await insertUser(db, 'contributor');
    const { uploadId } = await startUpload(deps(), user, file());
    await sendParts(user, uploadId, wavBytes(40), [1]);
    await expectUploadError(completeUpload(deps(), user, uploadId), 'incomplete');
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it('is safe to call twice', async () => {
    const user = await insertUser(db, 'contributor');
    const { uploadId } = await startUpload(deps(), user, file());
    await sendParts(user, uploadId, wavBytes(40));
    await completeUpload(deps(), user, uploadId);
    await expect(completeUpload(deps(), user, uploadId)).resolves.toMatchObject({
      status: 'uploaded',
    });
    expect(await db.select().from(audioAssets)).toHaveLength(1);
  });

  it('names the missing parts instead of completing', async () => {
    const user = await insertUser(db, 'contributor');
    const { uploadId, sermonId } = await startUpload(deps(), user, file());
    await sendParts(user, uploadId, wavBytes(40), [1, 3]);
    const error = await expectUploadError(completeUpload(deps(), user, uploadId), 'incomplete');
    expect(error.missingParts).toEqual([2]);
    const [sermon] = await db.select().from(sermons).where(eq(sermons.id, sermonId));
    expect(sermon.status).toBe('uploading');
    expect(await db.select().from(audioAssets)).toHaveLength(0);
  });

  it('rejects a part that is the wrong size', async () => {
    const user = await insertUser(db, 'contributor');
    const { uploadId } = await startUpload(deps(), user, file());
    const bytes = wavBytes(40);
    const { url } = await presignPartUrl(deps(), user, uploadId, 1);
    await putPart(store, url, bytes.slice(0, 10));
    await sendParts(user, uploadId, bytes, [2, 3]);
    const error = await expectUploadError(completeUpload(deps(), user, uploadId), 'incomplete');
    expect(error.missingParts).toEqual([1]);
  });

  it('can finish after the missing part is re-sent', async () => {
    const user = await insertUser(db, 'contributor');
    const bytes = wavBytes(40);
    const { uploadId } = await startUpload(deps(), user, file());
    await sendParts(user, uploadId, bytes, [1, 3]);
    await expectUploadError(completeUpload(deps(), user, uploadId), 'incomplete');
    await sendParts(user, uploadId, bytes, [2]);
    await expect(completeUpload(deps(), user, uploadId)).resolves.toMatchObject({
      status: 'uploaded',
    });
  });

  it('rejects a renamed non-audio file and withdraws the sermon', async () => {
    const user = await insertUser(db, 'contributor');
    const notAudio = new TextEncoder().encode('This is a text file pretending to be a recording.');
    const { uploadId, sermonId } = await startUpload(
      deps(),
      user,
      file({ filename: 'sermon.mp3', sizeBytes: notAudio.length }),
    );
    for (let n = 1; n <= Math.ceil(notAudio.length / PART); n++) {
      const { url } = await presignPartUrl(deps(), user, uploadId, n);
      await putPart(store, url, notAudio.slice((n - 1) * PART, n * PART));
    }
    await expectUploadError(completeUpload(deps(), user, uploadId), 'not_audio');
    const [sermon] = await db.select().from(sermons).where(eq(sermons.id, sermonId));
    expect(sermon.deletedAt).not.toBeNull();
    expect(sermon.status).not.toBe('uploaded');
    expect(await db.select().from(audioAssets)).toHaveLength(0);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(row.status).toBe('aborted');
  });

  it('cannot be done by someone else', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const { uploadId } = await startUpload(deps(), owner, file());
    await sendParts(owner, uploadId, wavBytes(40));
    await expectUploadError(completeUpload(deps(), other, uploadId), 'not_found');
  });
});

describe('abortUpload', () => {
  it('hides the unfinished sermon, discards its parts, and audits the cancellation', async () => {
    const user = await insertUser(db, 'contributor');
    const { uploadId, sermonId } = await startUpload(deps(), user, file());
    await sendParts(user, uploadId, wavBytes(40), [1]);
    await abortUpload(deps(), user, uploadId);
    const [sermon] = await db.select().from(sermons).where(eq(sermons.id, sermonId));
    expect(sermon.deletedAt).not.toBeNull();
    const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(row.status).toBe('aborted');
    await expectUploadError(presignPartUrl(deps(), user, uploadId, 2), 'not_found');
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, 'sermon.upload_cancelled')),
    ).toHaveLength(1);
  });

  it('does nothing to a finished upload: originals are never removed', async () => {
    const user = await insertUser(db, 'contributor');
    const { uploadId, sermonId } = await startUpload(deps(), user, file());
    await sendParts(user, uploadId, wavBytes(40));
    await completeUpload(deps(), user, uploadId);
    await abortUpload(deps(), user, uploadId);
    const [sermon] = await db.select().from(sermons).where(eq(sermons.id, sermonId));
    expect(sermon.deletedAt).toBeNull();
    expect(sermon.status).toBe('uploaded');
  });

  it('cannot cancel someone else’s upload', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const { uploadId } = await startUpload(deps(), owner, file());
    await expectUploadError(abortUpload(deps(), other, uploadId), 'not_found');
  });
});

describe('listQueue', () => {
  it('lists the person’s own unfinished sermons with their file names, newest first', async () => {
    const user = await insertUser(db, 'contributor');
    await startUpload(deps(), user, file({ filename: 'Tape14_SideA.wav' }));
    await startUpload(deps(), user, file({ filename: 'Tape14_SideB.wav' }));
    const queue = await listQueue(db, user);
    expect(queue.map((q) => q.filename)).toEqual(['Tape14_SideB.wav', 'Tape14_SideA.wav']);
    expect(queue[0]).toMatchObject({ status: 'uploading', sizeBytes: 40 });
  });

  it('never shows another person’s uploads, cancelled uploads, or approved sermons', async () => {
    const me = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    await startUpload(deps(), other, file({ filename: 'theirs.wav' }));
    const cancelled = await startUpload(deps(), me, file({ filename: 'cancelled.wav' }));
    await abortUpload(deps(), me, cancelled.uploadId);
    const done = await startUpload(deps(), me, file({ filename: 'approved.wav' }));
    await db.update(sermons).set({ status: 'approved' }).where(eq(sermons.id, done.sermonId));
    const mine = await startUpload(deps(), me, file({ filename: 'mine.wav' }));
    expect((await listQueue(db, me)).map((q) => q.sermonId)).toEqual([mine.sermonId]);
  });

  it('reports the running stage’s progress and a failed sermon’s reason', async () => {
    const me = await insertUser(db, 'contributor');
    const running = await startUpload(deps(), me, file({ filename: 'running.wav' }));
    await db
      .update(sermons)
      .set({ status: 'transcribing' })
      .where(eq(sermons.id, running.sermonId));
    await db
      .insert(jobs)
      .values({ sermonId: running.sermonId, type: 'transcribe', state: 'running', progress: 64 });
    const failed = await startUpload(deps(), me, file({ filename: 'failed.wav' }));
    await db
      .update(sermons)
      .set({
        status: 'failed',
        failedStage: 'transcribing',
        lastError: 'No speech was detected in this recording.',
      })
      .where(eq(sermons.id, failed.sermonId));
    await db
      .insert(jobs)
      .values({ sermonId: failed.sermonId, type: 'transcribe', state: 'failed', progress: 30 });
    const byName = Object.fromEntries((await listQueue(db, me)).map((q) => [q.filename, q]));
    expect(byName['running.wav']).toMatchObject({
      status: 'transcribing',
      progress: 64,
      failedStage: null,
    });
    expect(byName['failed.wav']).toMatchObject({
      status: 'failed',
      progress: null,
      failedStage: 'transcribing',
      lastError: 'No speech was detected in this recording.',
    });
  });

  it('is forbidden for viewers', async () => {
    const viewer = await insertUser(db, 'viewer');
    await expect(listQueue(db, viewer)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
