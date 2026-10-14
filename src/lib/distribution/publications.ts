import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '@/db/client';
import {
  audioAssets,
  auditLog,
  distributionChannels,
  publications,
  scriptureRefs,
  sermons,
  transcripts,
  users,
  type Publication,
} from '@/db/schema';
import { assertCan, canPublishSermon, type Actor } from '@/lib/permissions';
import { asReference } from '@/lib/review/service';
import { formatReference } from '@/lib/scripture/canon';
import { isApprovedOrLater } from '@/lib/sermon-status';
import { getSettings } from '@/lib/settings';
import { toText, type Segment } from '@/lib/transcripts/render';
import { connectedChannels, DistributionError, readYouTubeSettings } from './channels';
import { youtubeDescription, youtubeTitle, type NotesInput } from './show-notes';
import {
  CHANNEL_KINDS,
  CHANNEL_LABEL,
  isAppServed,
  isChannelKind,
  isVisibility,
  type ChannelKind,
  type PublicationState,
  type Visibility,
} from './states';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** Everything the show notes are built from, for one sermon. */
export async function loadNotesInput(
  db: Executor,
  sermonId: string,
  options: { transcript: boolean },
): Promise<NotesInput | null> {
  const [sermon] = await db.select().from(sermons).where(eq(sermons.id, sermonId));
  if (!sermon) return null;
  // getSettings only reads, so a transaction works as well as the pool.
  const profile = await getSettings(db as Db);
  const refs = await db
    .select()
    .from(scriptureRefs)
    .where(and(eq(scriptureRefs.sermonId, sermonId), isNull(scriptureRefs.deletedAt)))
    .orderBy(asc(scriptureRefs.spokenAtSec), asc(scriptureRefs.createdAt));
  let transcriptText: string | null = null;
  if (options.transcript) {
    const [latest] = await db
      .select({ segments: transcripts.segments })
      .from(transcripts)
      .where(eq(transcripts.sermonId, sermonId))
      .orderBy(desc(transcripts.version))
      .limit(1);
    transcriptText = latest
      ? toText(latest.segments as Segment[]).replace(/\n{2,}/g, '\n\n')
      : null;
  }
  return {
    title: sermon.title ?? 'Untitled sermon',
    recordedOn: sermon.recordedOn,
    speaker: sermon.speaker || profile.defaultSpeaker || null,
    churchName: profile.churchName,
    summary: sermon.summaryText,
    passages: refs.map((r) => ({
      ref: { book: r.book, chapter: r.chapter, verseStart: r.verseStart, verseEnd: r.verseEnd },
      spokenAtSec: r.spokenAtSec,
      isMainText: r.isMainText,
    })),
    transcriptText,
  };
}

/** What the YouTube cover shows. The worker draws the same four lines. */
export type CoverText = {
  church: string;
  title: string;
  passage: string | null;
  date: string | null;
};

export type PublicationSummary = {
  id: string;
  channel: ChannelKind;
  state: PublicationState;
  visibility: Visibility;
  remoteVisibility: Visibility | null;
  remoteUrl: string | null;
  lastError: string | null;
  publishedAt: Date | null;
  requestedAt: Date;
};

export type PublishPreview = {
  sermonId: string;
  youtube: { title: string; description: string };
  cover: CoverText;
  channels: {
    kind: ChannelKind;
    connected: boolean;
    defaultVisibility: Visibility;
    publication: PublicationSummary | null;
  }[];
  /** No podcast episode has ever gone out, so the first one needs a confirmation (SPEC §8). */
  firstPodcastEpisode: boolean;
  /** The sermon has no cleaned audio yet, so there is nothing to publish. */
  missingAudio: boolean;
};

async function lockPublishable(tx: Tx, actor: Actor, sermonId: string) {
  const [sermon] = await tx.select().from(sermons).where(eq(sermons.id, sermonId)).for('update');
  const facts = sermon && {
    contributorId: sermon.contributorId,
    status: sermon.status,
    deleted: sermon.deletedAt !== null,
  };
  if (!sermon || !facts || !canPublishSermon(actor, facts)) {
    throw new DistributionError(
      sermon && !isApprovedOrLater(sermon.status) ? 'conflict' : 'not_found',
      sermon && !isApprovedOrLater(sermon.status)
        ? 'Only approved sermons can be published.'
        : 'Sermon not found.',
    );
  }
  return sermon;
}

function summarize(p: Publication, kind: ChannelKind): PublicationSummary {
  return {
    id: p.id,
    channel: kind,
    state: p.state,
    visibility: p.visibility,
    remoteVisibility: p.remoteVisibility,
    remoteUrl: p.remoteUrl,
    lastError: p.lastError,
    publishedAt: p.publishedAt,
    requestedAt: p.requestedAt,
  };
}

/** A sermon's publications, for the Publishing card. Admins only. */
export async function publicationsForSermon(
  db: Db,
  actor: Actor,
  sermonId: string,
): Promise<PublicationSummary[]> {
  assertCan(actor.role, 'sermon.publish');
  const rows = await db
    .select({ p: publications, kind: distributionChannels.kind })
    .from(publications)
    .innerJoin(distributionChannels, eq(distributionChannels.id, publications.channelId))
    .where(eq(publications.sermonId, sermonId))
    .orderBy(asc(distributionChannels.kind));
  return rows.map((r) => summarize(r.p, r.kind));
}

const coverDate = (iso: string | null) => {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December']; // prettier-ignore
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
};

/** What the publish dialog shows: the exact title and description YouTube will get. */
export async function getPublishPreview(
  db: Db,
  actor: Actor,
  sermonId: string,
): Promise<PublishPreview | null> {
  assertCan(actor.role, 'sermon.publish');
  const [sermon] = await db.select().from(sermons).where(eq(sermons.id, sermonId));
  if (
    !sermon ||
    !canPublishSermon(actor, {
      contributorId: sermon.contributorId,
      status: sermon.status,
      deleted: sermon.deletedAt !== null,
    })
  )
    return null;
  const notes = await loadNotesInput(db, sermonId, { transcript: true });
  if (!notes) return null;
  const channels = await connectedChannels(db);
  const existing = await publicationsForSermon(db, actor, sermonId);
  const [everPodcast] = await db
    .select({ id: publications.id })
    .from(publications)
    .innerJoin(distributionChannels, eq(distributionChannels.id, publications.channelId))
    .where(and(eq(distributionChannels.kind, 'podcast'), isNotNull(publications.firstPublishedAt)))
    .limit(1);
  const [cleaned] = await db
    .select({ id: audioAssets.id })
    .from(audioAssets)
    .where(and(eq(audioAssets.sermonId, sermonId), eq(audioAssets.kind, 'cleaned')))
    .limit(1);
  const primary = asReference(sermon.primaryPassage);
  return {
    sermonId,
    youtube: { title: youtubeTitle(notes), description: youtubeDescription(notes) },
    cover: {
      church: notes.churchName,
      title: notes.title,
      passage: primary ? formatReference(primary) : null,
      date: coverDate(sermon.recordedOn),
    },
    channels: CHANNEL_KINDS.map((kind) => ({
      kind,
      connected: channels.has(kind),
      defaultVisibility:
        kind === 'youtube'
          ? readYouTubeSettings(channels.get('youtube')?.settings).defaultVisibility
          : 'public',
      publication: existing.find((p) => p.channel === kind) ?? null,
    })),
    firstPodcastEpisode: !everPodcast,
    missingAudio: !cleaned,
  };
}

export type PublishRequest = {
  channel: string;
  visibility?: string;
  /** The admin ticked "podcast episodes are public". Needed for the first episode. */
  confirmPublic?: boolean;
};

/**
 * Publishes an approved sermon to one channel. YouTube is queued for the worker, which renders and
 * uploads the video; a podcast episode or library entry is live at once. Admins only.
 */
export async function requestPublish(
  db: Db,
  actor: Actor,
  sermonId: string,
  input: PublishRequest,
): Promise<PublicationSummary> {
  assertCan(actor.role, 'sermon.publish');
  if (!isChannelKind(input.channel))
    throw new DistributionError(
      'invalid',
      'Choose YouTube, the podcast feed or the online library.',
    );
  const kind = input.channel;
  const visibility: Visibility = isAppServed(kind)
    ? 'public'
    : isVisibility(input.visibility)
      ? input.visibility
      : (() => {
          throw new DistributionError('invalid', 'Choose private, unlisted or public.');
        })();

  return db.transaction(async (tx) => {
    await lockPublishable(tx, actor, sermonId);
    const channel = (await connectedChannels(tx)).get(kind);
    if (!channel)
      throw new DistributionError(
        'conflict',
        kind === 'youtube'
          ? 'Connect YouTube on the Connections page first.'
          : `Turn on the ${kind === 'podcast' ? 'podcast feed' : 'online library'} on the Connections page first.`,
      );
    const [cleaned] = await tx
      .select({ id: audioAssets.id })
      .from(audioAssets)
      .where(and(eq(audioAssets.sermonId, sermonId), eq(audioAssets.kind, 'cleaned')))
      .limit(1);
    if (!cleaned)
      throw new DistributionError('conflict', 'This sermon has no cleaned recording to publish.');

    const [existing] = await tx
      .select()
      .from(publications)
      .where(and(eq(publications.sermonId, sermonId), eq(publications.channelId, channel.id)))
      .for('update');
    if (existing && !['failed', 'removed'].includes(existing.state)) {
      throw new DistributionError(
        'conflict',
        existing.state === 'published'
          ? `This sermon is already on ${CHANNEL_LABEL[kind]}.`
          : existing.state === 'removing'
            ? 'This sermon is being taken down. Try again when that has finished.'
            : 'This sermon is already being published.',
      );
    }

    if (kind === 'podcast' && !input.confirmPublic) {
      const [ever] = await tx
        .select({ id: publications.id })
        .from(publications)
        .where(
          and(eq(publications.channelId, channel.id), isNotNull(publications.firstPublishedAt)),
        )
        .limit(1);
      if (!ever)
        throw new DistributionError(
          'confirm',
          'Podcast episodes are public: anyone with the feed can download the recording. Confirm to publish the first one.',
        );
    }

    const notes = await loadNotesInput(tx, sermonId, { transcript: kind === 'youtube' });
    const title = youtubeTitle(notes!);
    const description = kind === 'youtube' ? youtubeDescription(notes!) : '';
    const now = new Date();
    const live = isAppServed(kind);
    const values = {
      state: (live ? 'published' : 'queued') as PublicationState,
      visibility,
      title,
      description,
      attempts: 0,
      runAfter: now,
      lastError: null,
      errorDetail: null,
      lockedBy: null,
      requestedBy: actor.id,
      requestedAt: now,
      publishedAt: live ? now : null,
      removedAt: null,
      removedBy: null,
      updatedAt: now,
    };
    let row: Publication;
    if (existing) {
      [row] = await tx
        .update(publications)
        .set({
          ...values,
          // A video already on YouTube only has its privacy changed back, so keep what it was sent with.
          ...(existing.remoteId
            ? { title: existing.title, description: existing.description }
            : {}),
          firstPublishedAt: live ? (existing.firstPublishedAt ?? now) : existing.firstPublishedAt,
        })
        .where(eq(publications.id, existing.id))
        .returning();
    } else {
      [row] = await tx
        .insert(publications)
        .values({ sermonId, channelId: channel.id, ...values, firstPublishedAt: live ? now : null })
        .returning();
    }
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: live ? 'publication.published' : 'publication.requested',
      entity: 'sermon',
      entityId: sermonId,
      diff: { channel: kind, visibility, publicationId: row.id },
    });
    return summarize(row, kind);
  });
}

async function lockPublication(tx: Tx, actor: Actor, publicationId: string) {
  const [found] = await tx
    .select({ p: publications, kind: distributionChannels.kind, sermon: sermons })
    .from(publications)
    .innerJoin(distributionChannels, eq(distributionChannels.id, publications.channelId))
    .innerJoin(sermons, eq(sermons.id, publications.sermonId))
    .where(eq(publications.id, publicationId))
    .for('update', { of: publications });
  if (!found) throw new DistributionError('not_found', 'That publication was not found.');
  // Taking something down is always allowed for an admin, even if the sermon was later deleted.
  assertCan(actor.role, 'sermon.publish');
  return found;
}

/**
 * Unpublishes. YouTube: the worker makes the video private (it is never deleted, so this can be
 * undone). Podcast and library: the sermon leaves at once and its audio link stops working.
 */
export async function requestUnpublish(
  db: Db,
  actor: Actor,
  publicationId: string,
): Promise<PublicationSummary> {
  assertCan(actor.role, 'sermon.publish');
  return db.transaction(async (tx) => {
    const { p, kind } = await lockPublication(tx, actor, publicationId);
    if (p.state === 'publishing')
      throw new DistributionError(
        'conflict',
        'This is uploading right now. Try again when it has finished.',
      );
    if (p.state === 'removed' || p.state === 'removing')
      throw new DistributionError('conflict', 'This has already been taken down.');
    const now = new Date();
    // Nothing on YouTube yet (still queued, or failed before the upload): just stop.
    const immediate = isAppServed(kind) || !p.remoteId;
    const [row] = await tx
      .update(publications)
      .set({
        state: immediate ? 'removed' : 'removing',
        removedBy: actor.id,
        removedAt: immediate ? now : null,
        attempts: 0,
        runAfter: now,
        lastError: null,
        errorDetail: null,
        updatedAt: now,
      })
      .where(eq(publications.id, p.id))
      .returning();
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: immediate ? 'publication.removed' : 'publication.remove_requested',
      entity: 'sermon',
      entityId: p.sermonId,
      diff: { channel: kind, publicationId: p.id, from: p.state },
    });
    return summarize(row, kind);
  });
}

/** Tries a failed YouTube publication again from where it stopped. */
export async function retryPublication(
  db: Db,
  actor: Actor,
  publicationId: string,
): Promise<PublicationSummary> {
  assertCan(actor.role, 'sermon.publish');
  return db.transaction(async (tx) => {
    const { p, kind, sermon } = await lockPublication(tx, actor, publicationId);
    if (p.state !== 'failed')
      throw new DistributionError('conflict', 'Only a failed publication can be tried again.');
    if (
      !canPublishSermon(actor, {
        contributorId: sermon.contributorId,
        status: sermon.status,
        deleted: sermon.deletedAt !== null,
      })
    )
      throw new DistributionError('conflict', 'This sermon can no longer be published.');
    const [row] = await tx
      .update(publications)
      .set({
        state: 'queued',
        attempts: 0,
        runAfter: new Date(),
        lastError: null,
        errorDetail: null,
        updatedAt: new Date(),
      })
      .where(eq(publications.id, p.id))
      .returning();
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'publication.retry',
      entity: 'sermon',
      entityId: p.sermonId,
      diff: { channel: kind, publicationId: p.id },
    });
    return summarize(row, kind);
  });
}

export type QueueRow = PublicationSummary & {
  sermonId: string;
  sermonTitle: string | null;
  stem: string | null;
  requestedByName: string;
  errorDetail: string | null;
  runAfter: Date;
  attempts: number;
  /** Queued, but held back until later (after a failure, or YouTube's daily quota). */
  waiting: boolean;
};

/** The Publishing page: everything publishing, recently published, failed or taken down. */
export async function listPublications(
  db: Db,
  actor: Actor,
  options: { states?: PublicationState[]; limit?: number } = {},
): Promise<QueueRow[]> {
  assertCan(actor.role, 'sermon.publish');
  const now = Date.now();
  const requester = alias(users, 'requester');
  const rows = await db
    .select({
      p: publications,
      kind: distributionChannels.kind,
      sermonTitle: sermons.title,
      stem: sermons.filenameStem,
      requestedByName: requester.name,
    })
    .from(publications)
    .innerJoin(distributionChannels, eq(distributionChannels.id, publications.channelId))
    .innerJoin(sermons, eq(sermons.id, publications.sermonId))
    .innerJoin(requester, eq(requester.id, publications.requestedBy))
    .where(options.states ? inArray(publications.state, options.states) : sql`true`)
    .orderBy(desc(publications.updatedAt))
    .limit(options.limit ?? 200);
  return rows.map((r) => ({
    ...summarize(r.p, r.kind),
    sermonId: r.p.sermonId,
    sermonTitle: r.sermonTitle,
    stem: r.stem,
    requestedByName: r.requestedByName,
    errorDetail: r.p.errorDetail,
    runAfter: r.p.runAfter,
    attempts: r.p.attempts,
    waiting: r.p.state === 'queued' && r.p.runAfter.getTime() > now,
  }));
}
