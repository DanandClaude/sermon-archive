import { desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { audioAssets, jobs, sermons, transcripts, uploads, users, type Job } from '@/db/schema';
import { assertCan, canRetrySermon, canViewSermon, type Actor } from '@/lib/permissions';
import type { SermonStatus } from '@/lib/sermon-status';
import type { Segment } from '@/lib/transcripts/render';

export type AssetSummary = { storageKey: string; peaksKey: string | null; bytes: number };

export type TranscriptDetail = {
  version: number;
  model: string;
  language: string;
  fullText: string;
  segments: Segment[];
  /** [segmentIndex, wordIndex] pairs the transcriber was unsure of. */
  lowConfidence: [number, number][];
  createdAt: Date;
};

export type SermonDetail = {
  id: string;
  title: string | null;
  filename: string | null;
  status: SermonStatus;
  recordedOn: string | null;
  speaker: string | null;
  side: string | null;
  batchLabel: string | null;
  labelScripture: string | null;
  durationSec: number | null;
  contributorName: string;
  createdAt: Date;
  failedStage: string | null;
  lastError: string | null;
  original: AssetSummary | null;
  /** The newest cleaned copy. */
  cleaned: AssetSummary | null;
  transcript: TranscriptDetail | null;
  canRetry: boolean;
  /** Raw job history, for admins only: it can contain technical error text. */
  jobs: Job[] | null;
};

const summary = (
  row: { storageKey: string; peaksKey: string | null; bytes: number } | undefined,
) => (row ? { storageKey: row.storageKey, peaksKey: row.peaksKey, bytes: row.bytes } : null);

/**
 * Everything the sermon page shows, or null if it doesn't exist or this person may not see it. Both
 * cases look the same, so a hidden draft can't be discovered by trying ids.
 */
export async function getSermonDetail(
  db: Db,
  actor: Actor,
  sermonId: string,
): Promise<SermonDetail | null> {
  assertCan(actor.role, 'library.browse');
  const [row] = await db
    .select({
      sermon: sermons,
      contributorName: users.name,
      filename: uploads.filename,
    })
    .from(sermons)
    .innerJoin(users, eq(users.id, sermons.contributorId))
    .leftJoin(uploads, eq(uploads.sermonId, sermons.id))
    .where(eq(sermons.id, sermonId));
  if (!row) return null;
  const { sermon } = row;
  const facts = {
    contributorId: sermon.contributorId,
    status: sermon.status,
    deleted: sermon.deletedAt !== null,
  };
  if (!canViewSermon(actor, facts)) return null;

  const assets = await db
    .select()
    .from(audioAssets)
    .where(eq(audioAssets.sermonId, sermonId))
    .orderBy(desc(audioAssets.createdAt));
  const [transcript] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.sermonId, sermonId))
    .orderBy(desc(transcripts.version))
    .limit(1);
  const jobRows =
    actor.role === 'admin'
      ? await db
          .select()
          .from(jobs)
          .where(eq(jobs.sermonId, sermonId))
          .orderBy(desc(jobs.createdAt))
      : null;

  return {
    id: sermon.id,
    title: sermon.title,
    filename: row.filename,
    status: sermon.status,
    recordedOn: sermon.recordedOn,
    speaker: sermon.speaker,
    side: sermon.side,
    batchLabel: sermon.batchLabel,
    labelScripture: sermon.labelScripture,
    durationSec: sermon.durationSec,
    contributorName: row.contributorName,
    createdAt: sermon.createdAt,
    failedStage: sermon.failedStage,
    lastError: sermon.lastError,
    original: summary(assets.find((a) => a.kind === 'original')),
    cleaned: summary(assets.find((a) => a.kind === 'cleaned')),
    transcript: transcript
      ? {
          version: transcript.version,
          model: transcript.model,
          language: transcript.language,
          fullText: transcript.fullText,
          segments: transcript.segments as Segment[],
          lowConfidence: transcript.lowConfidence as [number, number][],
          createdAt: transcript.createdAt,
        }
      : null,
    canRetry: canRetrySermon(actor, facts),
    jobs: jobRows,
  };
}

/** The current transcript for a sermon this person may see, for downloads. */
export async function getTranscriptForDownload(
  db: Db,
  actor: Actor,
  sermonId: string,
): Promise<{ segments: Segment[]; baseName: string } | null> {
  const detail = await getSermonDetail(db, actor, sermonId);
  if (!detail?.transcript) return null;
  const raw = detail.title ?? detail.filename?.replace(/\.[^.]+$/, '') ?? 'sermon';
  const baseName = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'sermon';
  return { segments: detail.transcript.segments, baseName };
}

/** A sermon id must look like a UUID before it reaches the database. */
export const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
