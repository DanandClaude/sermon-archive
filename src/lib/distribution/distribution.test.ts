import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  audioAssets,
  auditLog,
  distributionChannels,
  publications,
  scriptureRefs,
  sermons,
  transcripts,
} from '@/db/schema';
import { ForbiddenError } from '@/lib/errors';
import { ROLES } from '@/lib/roles';
import { decryptJson } from '@/lib/secrets';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import {
  connectTestYouTube,
  connectYouTube,
  disconnectChannel,
  DistributionError,
  listChannels,
  savePodcastSettings,
  saveYouTubeSettings,
} from './channels';
import { findEpisode, findEpisodeTranscript, getPodcastFeedXml } from './podcast';
import {
  getPublishPreview,
  listPublications,
  requestPublish,
  requestUnpublish,
  retryPublication,
} from './publications';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

const PROFILE = { churchName: 'Grace Church', defaultSpeaker: '' };
const PODCAST = {
  title: 'Grace Church Sermons',
  author: 'Grace Church',
  description: 'Sermons from the tape archive.',
  ownerEmail: '',
  language: 'en-us',
};

const rejects = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error, 'expected an error').toBeInstanceOf(DistributionError);
  expect((error as DistributionError).code).toBe(code);
  return error as DistributionError;
};

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
  await connectTestYouTube(db, admin);
  await savePodcastSettings(db, admin, PODCAST);
  return admin;
}

describe('permissions', () => {
  it('lets only admins publish, unpublish, retry, preview or list', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const pub = await requestPublish(db, admin, s.id, {
      channel: 'youtube',
      visibility: 'unlisted',
    });
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      const actor = await insertUser(db, role);
      const own = await sermon(actor);
      const attempts = [
        requestPublish(db, actor, own.id, { channel: 'youtube', visibility: 'public' }),
        requestPublish(db, actor, s.id, { channel: 'podcast', confirmPublic: true }),
        requestUnpublish(db, actor, pub.id),
        retryPublication(db, actor, pub.id),
        getPublishPreview(db, actor, s.id),
        listPublications(db, actor),
        listChannels(db, actor, PROFILE),
        connectTestYouTube(db, actor),
        savePodcastSettings(db, actor, PODCAST),
        saveYouTubeSettings(db, actor, { defaultVisibility: 'public', dailyUploads: 5 }),
        disconnectChannel(db, actor, 'youtube'),
      ];
      for (const attempt of attempts) await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await db.select().from(publications)).toHaveLength(1);
  });

  it('publishes approved and filed sermons only, never drafts or deleted ones', async () => {
    const admin = await setup();
    const draft = await sermon(admin, { status: 'needs_review', approvedAt: null });
    const deleted = await sermon(admin, { deletedAt: new Date() });
    const filed = await sermon(admin, { status: 'filed' });
    await rejects(
      requestPublish(db, admin, draft.id, { channel: 'youtube', visibility: 'public' }),
      'conflict',
    );
    await rejects(
      requestPublish(db, admin, deleted.id, { channel: 'youtube', visibility: 'public' }),
      'not_found',
    );
    await rejects(
      requestPublish(db, admin, crypto.randomUUID(), { channel: 'youtube', visibility: 'public' }),
      'not_found',
    );
    expect(await getPublishPreview(db, admin, draft.id)).toBeNull();
    const ok = await requestPublish(db, admin, filed.id, {
      channel: 'youtube',
      visibility: 'public',
    });
    expect(ok.state).toBe('queued');
  });
});

describe('connecting channels', () => {
  it('stores the YouTube sign-in encrypted and never lists it', async () => {
    const admin = await insertUser(db, 'admin');
    await connectYouTube(db, admin, {
      refreshToken: 'yt-secret-token',
      email: 'church@example.org',
    });
    const [row] = await db.select().from(distributionChannels);
    expect(row.encryptedConfig).not.toContain('yt-secret-token');
    expect(decryptJson(row.encryptedConfig!)).toMatchObject({ refreshToken: 'yt-secret-token' });
    const listed = await listChannels(db, admin, PROFILE);
    expect(JSON.stringify(listed)).not.toMatch(/yt-secret|encrypted/i);
    expect(listed.map((c) => [c.kind, c.connected, c.accountLabel])).toEqual([
      ['youtube', true, 'church@example.org'],
      ['podcast', false, null],
    ]);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain('yt-secret');
  });

  it('refuses a different YouTube account once videos belong to the first', async () => {
    const admin = await insertUser(db, 'admin');
    await connectYouTube(db, admin, { refreshToken: 'r', email: 'church@example.org' });
    await savePodcastSettings(db, admin, PODCAST);
    const s = await sermon(admin);
    await requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'unlisted' });
    await rejects(
      connectYouTube(db, admin, { refreshToken: 'r2', email: 'other@example.org' }),
      'conflict',
    );
    await connectYouTube(db, admin, { refreshToken: 'r3', email: 'CHURCH@example.org' });
    const [row] = await db
      .select()
      .from(distributionChannels)
      .where(eq(distributionChannels.kind, 'youtube'));
    expect(decryptJson(row.encryptedConfig!)).toMatchObject({ refreshToken: 'r3' });
  });

  it('wipes the YouTube sign-in on disconnect and stops new publishing', async () => {
    const admin = await setup();
    await disconnectChannel(db, admin, 'youtube');
    const [row] = await db
      .select()
      .from(distributionChannels)
      .where(eq(distributionChannels.kind, 'youtube'));
    expect(row.encryptedConfig).toBeNull();
    const s = await sermon(admin);
    await rejects(
      requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' }),
      'conflict',
    );
    await rejects(disconnectChannel(db, admin, 'youtube'), 'not_found');
  });

  it('validates settings and reports which field is wrong', async () => {
    const admin = await setup();
    const yt = await rejects(
      saveYouTubeSettings(db, admin, { defaultVisibility: 'public', dailyUploads: 500 }),
      'invalid',
    );
    expect(Object.keys(yt.fieldErrors ?? {})).toEqual(['dailyUploads']);
    const pod = await rejects(
      savePodcastSettings(db, admin, { ...PODCAST, language: 'english' }),
      'invalid',
    );
    expect(Object.keys(pod.fieldErrors ?? {})).toEqual(['language']);
    await saveYouTubeSettings(db, admin, { defaultVisibility: 'private', dailyUploads: 3 });
    const [youtube] = await listChannels(db, admin, PROFILE);
    expect(youtube.youtube).toEqual({ defaultVisibility: 'private', dailyUploads: 3 });
  });

  it('keeps when the feed was turned on when its details are saved again', async () => {
    const admin = await setup();
    const [before] = await db
      .select()
      .from(distributionChannels)
      .where(eq(distributionChannels.kind, 'podcast'));
    await savePodcastSettings(db, admin, { ...PODCAST, title: 'New name' });
    const [after] = await db
      .select()
      .from(distributionChannels)
      .where(eq(distributionChannels.kind, 'podcast'));
    expect(after.connectedAt).toEqual(before.connectedAt);
    expect(after.settings).toMatchObject({ title: 'New name' });
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions.filter((a) => a === 'channel.connect')).toHaveLength(2);
    expect(actions).toContain('channel.settings');
  });
});

describe('publishing', () => {
  it('queues YouTube with the title and description shown in the preview', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const preview = (await getPublishPreview(db, admin, s.id))!;
    expect(preview.cover).toMatchObject({ church: 'Your Church', title: 'Submitting to Leaders' });
    expect(preview.youtube.description).toContain('Hebrews 13:17 (main text), at 12:34');
    expect(preview.youtube.description).toContain('From the transcript\nTurn with me to Hebrews.');
    const pub = await requestPublish(db, admin, s.id, {
      channel: 'youtube',
      visibility: 'unlisted',
    });
    const [row] = await db.select().from(publications).where(eq(publications.id, pub.id));
    expect(row).toMatchObject({
      state: 'queued',
      visibility: 'unlisted',
      title: preview.youtube.title,
      description: preview.youtube.description,
      requestedBy: admin.id,
    });
    await rejects(
      requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' }),
      'conflict',
    );
  });

  it('refuses a sermon with no cleaned recording', async () => {
    const admin = await setup();
    const s = await sermon(admin, {}, { audio: false });
    expect((await getPublishPreview(db, admin, s.id))!.missingAudio).toBe(true);
    await rejects(
      requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' }),
      'conflict',
    );
  });

  it('refuses a channel or visibility that does not exist', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    await rejects(requestPublish(db, admin, s.id, { channel: 'tiktok' }), 'invalid');
    await rejects(
      requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'secret' }),
      'invalid',
    );
  });

  it('asks for confirmation before the first podcast episode only', async () => {
    const admin = await setup();
    const first = await sermon(admin);
    const second = await sermon(admin);
    expect((await getPublishPreview(db, admin, first.id))!.firstPodcastEpisode).toBe(true);
    await rejects(requestPublish(db, admin, first.id, { channel: 'podcast' }), 'confirm');
    const pub = await requestPublish(db, admin, first.id, {
      channel: 'podcast',
      confirmPublic: true,
    });
    expect(pub).toMatchObject({ state: 'published', visibility: 'public' });
    expect((await getPublishPreview(db, admin, second.id))!.firstPodcastEpisode).toBe(false);
    expect((await requestPublish(db, admin, second.id, { channel: 'podcast' })).state).toBe(
      'published',
    );
  });

  it('records every publish and unpublish in the audit log', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const yt = await requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' });
    const pod = await requestPublish(db, admin, s.id, { channel: 'podcast', confirmPublic: true });
    await requestUnpublish(db, admin, yt.id);
    await requestUnpublish(db, admin, pod.id);
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'publication.requested',
        'publication.published',
        'publication.removed',
      ]),
    );
  });
});

describe('unpublishing and retrying', () => {
  async function uploaded(admin: Awaited<ReturnType<typeof setup>>) {
    const s = await sermon(admin);
    const pub = await requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' });
    await db
      .update(publications)
      .set({
        state: 'published',
        remoteId: 'vid123',
        remoteUrl: 'https://youtu.be/vid123',
        publishedAt: new Date(),
      })
      .where(eq(publications.id, pub.id));
    return { s, pub };
  }

  it('cancels a queued upload at once, with nothing sent to YouTube', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const pub = await requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' });
    expect((await requestUnpublish(db, admin, pub.id)).state).toBe('removed');
  });

  it('hands a live video to the worker to make private, and refuses while uploading', async () => {
    const admin = await setup();
    const { s, pub } = await uploaded(admin);
    expect((await requestUnpublish(db, admin, pub.id)).state).toBe('removing');
    await rejects(requestUnpublish(db, admin, pub.id), 'conflict');
    await rejects(
      requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' }),
      'conflict',
    );

    const other = await sermon(admin);
    const busy = await requestPublish(db, admin, other.id, {
      channel: 'youtube',
      visibility: 'public',
    });
    await db.update(publications).set({ state: 'publishing' }).where(eq(publications.id, busy.id));
    await rejects(requestUnpublish(db, admin, busy.id), 'conflict');
  });

  it('republishing a private video keeps what it was sent with', async () => {
    const admin = await setup();
    const { s, pub } = await uploaded(admin);
    await db.update(publications).set({ state: 'removed' }).where(eq(publications.id, pub.id));
    await db.update(sermons).set({ title: 'A new title' }).where(eq(sermons.id, s.id));
    const again = await requestPublish(db, admin, s.id, {
      channel: 'youtube',
      visibility: 'unlisted',
    });
    const [row] = await db.select().from(publications).where(eq(publications.id, again.id));
    expect(again.id).toBe(pub.id);
    expect(row).toMatchObject({
      state: 'queued',
      visibility: 'unlisted',
      title: 'Submitting to Leaders',
      remoteId: 'vid123',
    });
  });

  it('retries only failed publications', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const pub = await requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' });
    await rejects(retryPublication(db, admin, pub.id), 'conflict');
    await db
      .update(publications)
      .set({ state: 'failed', attempts: 5, lastError: 'YouTube said no.' })
      .where(eq(publications.id, pub.id));
    const retried = await retryPublication(db, admin, pub.id);
    expect(retried).toMatchObject({ state: 'queued', lastError: null });
    await rejects(retryPublication(db, admin, crypto.randomUUID()), 'not_found');
  });

  it('lists publications with who asked for them', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    await requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' });
    const rows = await listPublications(db, admin);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'youtube',
      sermonId: s.id,
      requestedByName: admin.name,
    });
  });
});

describe('the podcast feed', () => {
  const APP = 'https://archive.example.test';

  it('is not served until the feed is turned on, and stops when it is turned off', async () => {
    const admin = await insertUser(db, 'admin');
    expect(await getPodcastFeedXml(db, APP)).toBeNull();
    await savePodcastSettings(db, admin, PODCAST);
    expect(await getPodcastFeedXml(db, APP)).toContain('<title>Grace Church Sermons</title>');
    await disconnectChannel(db, admin, 'podcast');
    expect(await getPodcastFeedXml(db, APP)).toBeNull();
  });

  it('lists live episodes only, with app links for audio and transcript', async () => {
    const admin = await setup();
    const live = await sermon(admin, { title: 'Live one' });
    const removed = await sermon(admin, { title: 'Taken down' });
    const deleted = await sermon(admin, { title: 'Deleted later' });
    const livePub = await requestPublish(db, admin, live.id, {
      channel: 'podcast',
      confirmPublic: true,
    });
    const removedPub = await requestPublish(db, admin, removed.id, { channel: 'podcast' });
    const deletedPub = await requestPublish(db, admin, deleted.id, { channel: 'podcast' });
    await requestPublish(db, admin, live.id, { channel: 'youtube', visibility: 'public' });
    await requestUnpublish(db, admin, removedPub.id);
    await db.update(sermons).set({ deletedAt: new Date() }).where(eq(sermons.id, deleted.id));

    const xml = (await getPodcastFeedXml(db, APP))!;
    expect(xml).toContain('<title>Live one</title>');
    expect(xml).not.toContain('Taken down');
    expect(xml).not.toContain('Deleted later');
    expect(xml).toContain(
      `<enclosure url="${APP}/podcast/episodes/${livePub.id}.mp3" length="4321"`,
    );
    expect(xml).toContain(`${APP}/podcast/episodes/${livePub.id}.srt`);
    expect(xml).not.toContain('cleaned/');
    expect(xml.match(/<item>/g)).toHaveLength(1);

    expect(await findEpisode(db, livePub.id)).toMatchObject({ kind: 'live', bytes: 4321 });
    expect(await findEpisode(db, removedPub.id)).toEqual({ kind: 'gone' });
    expect(await findEpisode(db, deletedPub.id)).toEqual({ kind: 'gone' });
    expect(await findEpisode(db, crypto.randomUUID())).toEqual({ kind: 'missing' });
    const transcript = await findEpisodeTranscript(db, livePub.id);
    expect(transcript.kind === 'live' && transcript.segments[0].text).toBe(
      'Turn with me to Hebrews.',
    );
  });

  it('never serves a YouTube publication as a podcast episode', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const yt = await requestPublish(db, admin, s.id, { channel: 'youtube', visibility: 'public' });
    await db.update(publications).set({ state: 'published' }).where(eq(publications.id, yt.id));
    expect(await findEpisode(db, yt.id)).toEqual({ kind: 'missing' });
  });

  it('keeps an episode out of the feed and its links dead while the feed is off', async () => {
    const admin = await setup();
    const s = await sermon(admin);
    const pub = await requestPublish(db, admin, s.id, { channel: 'podcast', confirmPublic: true });
    await disconnectChannel(db, admin, 'podcast');
    expect(await findEpisode(db, pub.id)).toEqual({ kind: 'missing' });
    await savePodcastSettings(db, admin, PODCAST);
    expect((await findEpisode(db, pub.id)).kind).toBe('live');
  });
});
