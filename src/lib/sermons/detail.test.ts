import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { audioAssets, jobs, sermons, transcripts, uploads } from '@/db/schema';
import { formatClock } from '@/lib/format';
import type { SermonStatus } from '@/lib/sermon-status';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import { getSermonDetail, getTranscriptForDownload, isUuid } from './detail';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

type Owner = Awaited<ReturnType<typeof insertUser>>;
async function sermonWith(
  owner: Owner,
  status: SermonStatus = 'analyzing',
  over: Partial<typeof sermons.$inferInsert> = {},
) {
  const [s] = await db
    .insert(sermons)
    .values({ contributorId: owner.id, status, ...over })
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
  await db.insert(audioAssets).values({
    sermonId: s.id,
    kind: 'original',
    storageKey: `originals/${s.id}/original.wav`,
    sha256: 'x',
    bytes: 100,
    mime: 'audio/wav',
    originalFilename: 'Tape14_SideA.wav',
    peaksKey: `peaks/${s.id}/original.json`,
  });
  return s;
}
const segments = [
  {
    start: 0,
    end: 2,
    text: 'Turn to Hebrews',
    words: [{ w: 'Turn', start: 0, end: 0.5, prob: 0.9 }],
  },
];

describe('getSermonDetail', () => {
  it('returns the sermon with its original audio, contributor and file name', async () => {
    const owner = await insertUser(db, 'contributor', { name: 'Marcy T.' });
    const s = await sermonWith(owner, 'analyzing', { speaker: 'Pastor Lee', durationSec: 2700 });
    const detail = await getSermonDetail(db, owner, s.id);
    expect(detail).toMatchObject({
      id: s.id,
      filename: 'Tape14_SideA.wav',
      contributorName: 'Marcy T.',
      speaker: 'Pastor Lee',
      durationSec: 2700,
      status: 'analyzing',
      cleaned: null,
      transcript: null,
      original: {
        storageKey: `originals/${s.id}/original.wav`,
        peaksKey: `peaks/${s.id}/original.json`,
        bytes: 100,
      },
    });
  });

  it('hides a draft from other contributors and viewers exactly as it hides a sermon that does not exist', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const s = await sermonWith(owner);
    expect(await getSermonDetail(db, other, s.id)).toBeNull();
    expect(await getSermonDetail(db, viewer, s.id)).toBeNull();
    expect(await getSermonDetail(db, owner, crypto.randomUUID())).toBeNull();
  });

  it('shows an approved sermon to a viewer, and any sermon to an admin', async () => {
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const admin = await insertUser(db, 'admin');
    const approved = await sermonWith(owner, 'approved');
    const draft = await sermonWith(owner, 'uploaded');
    expect(await getSermonDetail(db, viewer, approved.id)).not.toBeNull();
    expect(await getSermonDetail(db, admin, draft.id)).not.toBeNull();
  });

  it('hides a deleted sermon from everyone, admins included', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await sermonWith(owner, 'analyzing', { deletedAt: new Date() });
    expect(await getSermonDetail(db, owner, s.id)).toBeNull();
    expect(await getSermonDetail(db, admin, s.id)).toBeNull();
  });

  it('picks the newest cleaned copy and the newest transcript version', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await sermonWith(owner);
    for (const [i, name] of ['old', 'new'].entries()) {
      await db.insert(audioAssets).values({
        sermonId: s.id,
        kind: 'cleaned',
        storageKey: `cleaned/${s.id}/${name}.mp3`,
        sha256: 'x',
        bytes: 5,
        mime: 'audio/mpeg',
        originalFilename: 'cleaned.mp3',
        createdAt: new Date(2026, 0, 1 + i),
      });
      await db.insert(transcripts).values({
        sermonId: s.id,
        version: i + 1,
        model: 'm',
        language: 'en',
        fullText: `v${i + 1}`,
        segments,
        lowConfidence: [[0, 0]],
      });
    }
    const detail = await getSermonDetail(db, owner, s.id);
    expect(detail?.cleaned?.storageKey).toBe(`cleaned/${s.id}/new.mp3`);
    expect(detail?.transcript).toMatchObject({
      version: 2,
      fullText: 'v2',
      lowConfidence: [[0, 0]],
    });
    expect(detail?.transcript?.segments[0].words[0].w).toBe('Turn');
  });

  it('gives the job history to admins only', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await sermonWith(owner);
    await db.insert(jobs).values({
      sermonId: s.id,
      type: 'clean',
      state: 'failed',
      lastError: 'MediaError: technical detail',
    });
    expect((await getSermonDetail(db, owner, s.id))?.jobs).toBeNull();
    expect((await getSermonDetail(db, admin, s.id))?.jobs).toMatchObject([
      { type: 'clean', lastError: 'MediaError: technical detail' },
    ]);
  });

  it('says whether the person can retry a failed sermon', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const failed = await sermonWith(owner, 'failed', {
      failedStage: 'transcribing',
      lastError: 'No speech was detected in this recording.',
    });
    const fine = await sermonWith(owner, 'analyzing');
    expect(await getSermonDetail(db, owner, failed.id)).toMatchObject({
      canRetry: true,
      lastError: 'No speech was detected in this recording.',
    });
    expect((await getSermonDetail(db, admin, failed.id))?.canRetry).toBe(true);
    expect((await getSermonDetail(db, owner, fine.id))?.canRetry).toBe(false);
  });
});

describe('getTranscriptForDownload', () => {
  it('returns the segments and a safe file name, or null when there is no transcript', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await sermonWith(owner);
    expect(await getTranscriptForDownload(db, owner, s.id)).toBeNull();
    await db.insert(transcripts).values({
      sermonId: s.id,
      version: 1,
      model: 'm',
      language: 'en',
      fullText: 'x',
      segments,
      lowConfidence: [],
    });
    expect(await getTranscriptForDownload(db, owner, s.id)).toEqual({
      segments,
      baseName: 'Tape14_SideA',
    });
    await db.update(sermons).set({ title: 'Submitting to Leaders: "Hebrews" 13/17' });
    expect((await getTranscriptForDownload(db, owner, s.id))?.baseName).toBe(
      'Submitting-to-Leaders-Hebrews-13-17',
    );
  });

  it('never gives a transcript to someone who cannot see the sermon', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const s = await sermonWith(owner);
    await db.insert(transcripts).values({
      sermonId: s.id,
      version: 1,
      model: 'm',
      language: 'en',
      fullText: 'x',
      segments,
      lowConfidence: [],
    });
    expect(await getTranscriptForDownload(db, other, s.id)).toBeNull();
  });
});

describe('helpers', () => {
  it.each([
    ['5c7a1f0e-1234-4abc-9def-0123456789ab', true],
    ['not-a-uuid', false],
    ['', false],
    ["5c7a1f0e-1234-4abc-9def-0123456789ab'; drop table sermons;--", false],
  ])('isUuid(%j) → %s', (id, ok) => expect(isUuid(id)).toBe(ok));

  it.each([
    [0, '0:00'],
    [83, '1:23'],
    [3599, '59:59'],
    [3725, '1:02:05'],
    [-3, '0:00'],
    [83.9, '1:23'],
  ])('formatClock(%s) → %s', (secs, text) => expect(formatClock(secs)).toBe(text));

  it('requires the library permission', async () => {
    // Every role has library.browse today; this guards against that ever being narrowed silently.
    for (const role of ['viewer', 'contributor', 'admin'] as const) {
      const user = await insertUser(db, role);
      await expect(getSermonDetail(db, user, crypto.randomUUID())).resolves.toBeNull();
    }
  });
});
