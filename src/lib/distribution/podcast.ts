import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import {
  audioAssets,
  distributionChannels,
  publications,
  scriptureRefs,
  sermons,
  transcripts,
} from '@/db/schema';
import { getSettings } from '@/lib/settings';
import { isApprovedOrLater } from '@/lib/sermon-status';
import type { Segment } from '@/lib/transcripts/render';
import { isConnected, readPodcastSettings } from './channels';
import { buildFeed, type FeedEpisode } from './feed';
import { podcastNotesHtml, podcastNotesText, type NotesInput } from './show-notes';

/**
 * The public side of the podcast: the feed, each episode's audio, transcript and the cover art.
 * There is no sign-in here, so everything is limited to episodes an admin published: a sermon that
 * was never published, was taken down, or was deleted is not reachable, whatever the id.
 */

export const FEED_PATH = '/podcast/feed.xml';
export const ARTWORK_PATH = '/podcast/artwork.png';
export const episodeAudioPath = (id: string) => `/podcast/episodes/${id}.mp3`;
export const episodeTranscriptPath = (id: string) => `/podcast/episodes/${id}.srt`;

async function podcastChannel(db: Db) {
  const [row] = await db
    .select()
    .from(distributionChannels)
    .where(eq(distributionChannels.kind, 'podcast'));
  return row && isConnected(row) ? row : null;
}

/** The whole feed, or null when the podcast is not turned on. */
export async function getPodcastFeedXml(db: Db, appUrl: string, now = new Date()) {
  const channel = await podcastChannel(db);
  if (!channel) return null;
  const profile = await getSettings(db);
  const show = readPodcastSettings(channel.settings, profile);

  const rows = await db
    .select({ p: publications, sermon: sermons })
    .from(publications)
    .innerJoin(sermons, eq(sermons.id, publications.sermonId))
    .where(
      and(
        eq(publications.channelId, channel.id),
        eq(publications.state, 'published'),
        isNull(sermons.deletedAt),
      ),
    );
  const live = rows.filter((r) => isApprovedOrLater(r.sermon.status));
  const ids = live.map((r) => r.sermon.id);
  const assets = ids.length
    ? await db
        .select()
        .from(audioAssets)
        .where(and(inArray(audioAssets.sermonId, ids), eq(audioAssets.kind, 'cleaned')))
        .orderBy(desc(audioAssets.createdAt))
    : [];
  const refs = ids.length
    ? await db
        .select()
        .from(scriptureRefs)
        .where(and(inArray(scriptureRefs.sermonId, ids), isNull(scriptureRefs.deletedAt)))
        .orderBy(asc(scriptureRefs.spokenAtSec), asc(scriptureRefs.createdAt))
    : [];

  const episodes: FeedEpisode[] = [];
  for (const { p, sermon } of live) {
    const audio = assets.find((a) => a.sermonId === sermon.id);
    if (!audio) continue;
    const notes: NotesInput = {
      title: sermon.title ?? 'Untitled sermon',
      recordedOn: sermon.recordedOn,
      speaker: sermon.speaker || profile.defaultSpeaker || null,
      churchName: profile.churchName,
      summary: sermon.summaryText,
      passages: refs
        .filter((r) => r.sermonId === sermon.id)
        .map((r) => ({
          ref: { book: r.book, chapter: r.chapter, verseStart: r.verseStart, verseEnd: r.verseEnd },
          spokenAtSec: r.spokenAtSec,
          isMainText: r.isMainText,
        })),
      transcriptText: null,
    };
    episodes.push({
      guid: p.id,
      title: notes.title,
      notesText: podcastNotesText(notes),
      notesHtml: podcastNotesHtml(notes),
      pubDate: p.firstPublishedAt ?? p.publishedAt ?? p.requestedAt,
      audioUrl: `${appUrl}${episodeAudioPath(p.id)}`,
      bytes: audio.bytes,
      durationSec: audio.durationSec ?? sermon.durationSec,
      transcriptUrl: `${appUrl}${episodeTranscriptPath(p.id)}`,
    });
  }
  return buildFeed({
    show,
    siteUrl: appUrl,
    feedUrl: `${appUrl}${FEED_PATH}`,
    artworkUrl: channel.artworkKey ? `${appUrl}${ARTWORK_PATH}` : null,
    episodes,
    builtAt: now,
  });
}

export type EpisodeLookup =
  | { kind: 'live'; sermonId: string; audioKey: string; bytes: number }
  | { kind: 'gone' }
  | { kind: 'missing' };

/**
 * One episode by its publication id. `gone` is an episode that was published and then taken down
 * (podcast apps drop it on a 410); anything else that is not live looks the same as no such id.
 */
export async function findEpisode(db: Db, publicationId: string): Promise<EpisodeLookup> {
  const channel = await podcastChannel(db);
  if (!channel) return { kind: 'missing' };
  const [row] = await db
    .select({ p: publications, sermon: sermons })
    .from(publications)
    .innerJoin(sermons, eq(sermons.id, publications.sermonId))
    .where(and(eq(publications.id, publicationId), eq(publications.channelId, channel.id)));
  if (!row) return { kind: 'missing' };
  const live =
    row.p.state === 'published' &&
    row.sermon.deletedAt === null &&
    isApprovedOrLater(row.sermon.status);
  if (!live) return row.p.firstPublishedAt ? { kind: 'gone' } : { kind: 'missing' };
  const [audio] = await db
    .select()
    .from(audioAssets)
    .where(and(eq(audioAssets.sermonId, row.sermon.id), eq(audioAssets.kind, 'cleaned')))
    .orderBy(desc(audioAssets.createdAt))
    .limit(1);
  if (!audio) return { kind: 'missing' };
  return { kind: 'live', sermonId: row.sermon.id, audioKey: audio.storageKey, bytes: audio.bytes };
}

/** The transcript segments of a live episode, or the same `gone`/`missing` as the audio. */
export async function findEpisodeTranscript(
  db: Db,
  publicationId: string,
): Promise<{ kind: 'live'; segments: Segment[] } | { kind: 'gone' } | { kind: 'missing' }> {
  const episode = await findEpisode(db, publicationId);
  if (episode.kind !== 'live') return episode;
  const [latest] = await db
    .select({ segments: transcripts.segments })
    .from(transcripts)
    .where(eq(transcripts.sermonId, episode.sermonId))
    .orderBy(desc(transcripts.version))
    .limit(1);
  return latest ? { kind: 'live', segments: latest.segments as Segment[] } : { kind: 'missing' };
}

/** The cover art the worker drew, when the podcast is on. */
export async function podcastArtworkKey(db: Db): Promise<string | null> {
  const channel = await podcastChannel(db);
  return channel?.artworkKey ?? null;
}
