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
import { asReference } from '@/lib/review/service';
import { formatReference } from '@/lib/scripture/canon';
import { isApprovedOrLater } from '@/lib/sermon-status';
import { getSettings } from '@/lib/settings';
import type { Segment } from '@/lib/transcripts/render';
import { isConnected, readLibrarySettings, type LibrarySettings } from './channels';

/**
 * The public online library: anyone can browse and listen, with no sign-in. Everything here goes
 * through `liveEntries`, so only sermons an admin published to the library are reachable: a sermon
 * that was never published there, was taken down, was deleted, or whose library is turned off
 * looks the same as no such id. Entries are addressed by publication id, never sermon id.
 */

export const LIBRARY_PATH = '/listen';
export const libraryEntryPath = (id: string) => `/listen/${id}`;
export const libraryAudioPath = (id: string) => `/listen/${id}/audio`;

export type LibraryInfo = LibrarySettings & { churchName: string };

export type LibraryEntry = {
  id: string;
  title: string;
  recordedOn: string | null;
  speaker: string | null;
  /** The main passage, as listeners see it, e.g. "Hebrews 13:17". */
  passage: string | null;
  /** Every passage named, for search. */
  passages: string[];
  durationSec: number | null;
  summary: string | null;
  publishedAt: Date;
};

export type LibraryPassage = { label: string; spokenAtSec: number | null; isMainText: boolean };

export type LibrarySermon = {
  entry: LibraryEntry;
  passages: LibraryPassage[];
  segments: Segment[];
};

async function libraryChannel(db: Db) {
  const [row] = await db
    .select()
    .from(distributionChannels)
    .where(eq(distributionChannels.kind, 'library'));
  return row && isConnected(row) ? row : null;
}

/** The library's name and description, or null when it is turned off. */
export async function getLibraryInfo(db: Db): Promise<LibraryInfo | null> {
  const channel = await libraryChannel(db);
  if (!channel) return null;
  const profile = await getSettings(db);
  return { ...readLibrarySettings(channel.settings, profile), churchName: profile.churchName };
}

/** Live entries, optionally just one. The single place that decides what the public can see. */
async function liveEntries(db: Db, publicationId?: string): Promise<LibraryEntry[]> {
  const channel = await libraryChannel(db);
  if (!channel) return [];
  const rows = await db
    .select({ p: publications, sermon: sermons })
    .from(publications)
    .innerJoin(sermons, eq(sermons.id, publications.sermonId))
    .where(
      and(
        eq(publications.channelId, channel.id),
        eq(publications.state, 'published'),
        isNull(sermons.deletedAt),
        publicationId ? eq(publications.id, publicationId) : undefined,
      ),
    );
  const live = rows.filter((r) => isApprovedOrLater(r.sermon.status));
  const ids = live.map((r) => r.sermon.id);
  if (ids.length === 0) return [];
  const [withAudio, refs, profile] = await Promise.all([
    db
      .selectDistinct({ sermonId: audioAssets.sermonId })
      .from(audioAssets)
      .where(
        and(
          inArray(audioAssets.sermonId, ids),
          eq(audioAssets.kind, 'cleaned'),
          isNull(audioAssets.setAsideAt),
        ),
      ),
    db
      .select()
      .from(scriptureRefs)
      .where(and(inArray(scriptureRefs.sermonId, ids), isNull(scriptureRefs.deletedAt)))
      .orderBy(asc(scriptureRefs.spokenAtSec), asc(scriptureRefs.createdAt)),
    getSettings(db),
  ]);
  const playable = new Set(withAudio.map((a) => a.sermonId));
  return live
    .filter((r) => playable.has(r.sermon.id))
    .map(({ p, sermon }) => {
      const primary = asReference(sermon.primaryPassage);
      return {
        id: p.id,
        title: sermon.title ?? 'Untitled sermon',
        recordedOn: sermon.recordedOn,
        speaker: sermon.speaker || profile.defaultSpeaker || null,
        passage: primary ? formatReference(primary) : null,
        passages: refs
          .filter((r) => r.sermonId === sermon.id)
          .map((r) =>
            formatReference({
              book: r.book,
              chapter: r.chapter,
              verseStart: r.verseStart,
              verseEnd: r.verseEnd,
            }),
          ),
        durationSec: sermon.durationSec,
        summary: sermon.summaryText,
        publishedAt: p.firstPublishedAt ?? p.publishedAt ?? p.requestedAt,
      };
    });
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Does the entry match every word typed? Title, speaker, passages and year all count. */
export function matchesSearch(entry: LibraryEntry, query: string): boolean {
  const words = normalize(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalize(
    [
      entry.title,
      entry.speaker ?? '',
      entry.recordedOn ?? '',
      entry.passage ?? '',
      ...entry.passages,
    ].join(' '),
  );
  return words.every((w) => haystack.includes(w));
}

/** The library page: newest recording first. Null when the library is turned off. */
export async function listLibrary(
  db: Db,
  query = '',
): Promise<{ info: LibraryInfo; entries: LibraryEntry[]; total: number } | null> {
  const info = await getLibraryInfo(db);
  if (!info) return null;
  const all = await liveEntries(db);
  all.sort(
    (a, b) =>
      (b.recordedOn ?? '').localeCompare(a.recordedOn ?? '') ||
      b.publishedAt.getTime() - a.publishedAt.getTime(),
  );
  return { info, entries: all.filter((e) => matchesSearch(e, query)), total: all.length };
}

/** One sermon's public page, or null if it isn't live in the library. */
export async function getLibrarySermon(
  db: Db,
  publicationId: string,
): Promise<LibrarySermon | null> {
  const [entry] = await liveEntries(db, publicationId);
  if (!entry) return null;
  const [{ sermonId }] = await db
    .select({ sermonId: publications.sermonId })
    .from(publications)
    .where(eq(publications.id, publicationId));
  const [refs, [latest]] = await Promise.all([
    db
      .select()
      .from(scriptureRefs)
      .where(and(eq(scriptureRefs.sermonId, sermonId), isNull(scriptureRefs.deletedAt)))
      .orderBy(asc(scriptureRefs.spokenAtSec), asc(scriptureRefs.createdAt)),
    db
      .select({ segments: transcripts.segments })
      .from(transcripts)
      .where(eq(transcripts.sermonId, sermonId))
      .orderBy(desc(transcripts.version))
      .limit(1),
  ]);
  return {
    entry,
    passages: refs.map((r) => ({
      label: formatReference({
        book: r.book,
        chapter: r.chapter,
        verseStart: r.verseStart,
        verseEnd: r.verseEnd,
      }),
      spokenAtSec: r.spokenAtSec,
      isMainText: r.isMainText,
    })),
    segments: (latest?.segments as Segment[] | undefined) ?? [],
  };
}

/** The storage key of a live entry's cleaned recording, or null. */
export async function findLibraryAudio(db: Db, publicationId: string): Promise<string | null> {
  const [entry] = await liveEntries(db, publicationId);
  if (!entry) return null;
  const [audio] = await db
    .select({ key: audioAssets.storageKey })
    .from(audioAssets)
    .innerJoin(publications, eq(publications.sermonId, audioAssets.sermonId))
    .where(
      and(
        eq(publications.id, publicationId),
        eq(audioAssets.kind, 'cleaned'),
        isNull(audioAssets.setAsideAt),
      ),
    )
    .orderBy(desc(audioAssets.createdAt))
    .limit(1);
  return audio?.key ?? null;
}
