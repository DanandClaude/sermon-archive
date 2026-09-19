import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '@/db/client';
import {
  audioAssets,
  jobs,
  scriptureRefs,
  sermons,
  sermonTags,
  tags,
  transcripts,
  uploads,
  users,
  type Job,
} from '@/db/schema';
import {
  assertCan,
  canApproveSermon,
  canEditSermon,
  canRetrySermon,
  canViewSermon,
  type Actor,
} from '@/lib/permissions';
import { approvalProblems, asReference } from '@/lib/review/service';
import type { Reference } from '@/lib/scripture/canon';
import { isApprovedOrLater, type SermonStatus } from '@/lib/sermon-status';
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

export type ScriptureItem = {
  id: string;
  ref: Reference;
  spokenAtSec: number;
  contextNote: string | null;
  /** 'auto' was found by the system; 'manual' was added by a person. */
  source: 'auto' | 'manual';
  /** A person changed what the system found. */
  edited: boolean;
  isMainText: boolean;
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
  summary: { text: string; source: 'auto' | 'edited' } | null;
  primaryPassage: Reference | null;
  /** Set when the sermon is approved. */
  filenameStem: string | null;
  approvedAt: Date | null;
  approvedByName: string | null;
  /** Testament, genre, book and topic tags. */
  tags: { kind: string; name: string }[];
  /** Passages the pastor named, in the order they were spoken. Deleted ones are left out. */
  scripture: ScriptureItem[];
  /** Topics already used elsewhere, offered as suggestions. Only filled in for people who can edit. */
  topicSuggestions: string[];
  /** Details, summary and passages can be changed. */
  canEdit: boolean;
  canApprove: boolean;
  canRegenerate: boolean;
  /** What still blocks approval, keyed by field. */
  approvalProblems: Record<string, string>;
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
  const approver = alias(users, 'approver');
  const [row] = await db
    .select({
      sermon: sermons,
      contributorName: users.name,
      approvedByName: approver.name,
      filename: uploads.filename,
    })
    .from(sermons)
    .innerJoin(users, eq(users.id, sermons.contributorId))
    .leftJoin(approver, eq(approver.id, sermons.approvedBy))
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
  const refs = await db
    .select()
    .from(scriptureRefs)
    .where(and(eq(scriptureRefs.sermonId, sermonId), isNull(scriptureRefs.deletedAt)))
    .orderBy(asc(scriptureRefs.spokenAtSec), asc(scriptureRefs.createdAt));
  const tagRows = await db
    .select({ kind: tags.kind, name: tags.name })
    .from(sermonTags)
    .innerJoin(tags, eq(tags.id, sermonTags.tagId))
    .where(eq(sermonTags.sermonId, sermonId))
    .orderBy(asc(tags.kind), asc(tags.name));
  const editable =
    canEditSermon(actor, facts) &&
    (sermon.status === 'needs_review' || isApprovedOrLater(sermon.status));
  const topicSuggestions = editable
    ? (
        await db
          .selectDistinct({ name: tags.name })
          .from(tags)
          .where(eq(tags.kind, 'topic'))
          .orderBy(asc(tags.name))
          .limit(200)
      ).map((t) => t.name)
    : [];
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
    summary: sermon.summaryText
      ? { text: sermon.summaryText, source: sermon.summarySource === 'edited' ? 'edited' : 'auto' }
      : null,
    primaryPassage: asReference(sermon.primaryPassage),
    filenameStem: sermon.filenameStem,
    approvedAt: sermon.approvedAt,
    approvedByName: row.approvedByName,
    tags: tagRows,
    scripture: refs.map((r) => ({
      id: r.id,
      ref: { book: r.book, chapter: r.chapter, verseStart: r.verseStart, verseEnd: r.verseEnd },
      spokenAtSec: r.spokenAtSec,
      contextNote: r.contextNote,
      source: r.source === 'manual' ? 'manual' : 'auto',
      edited: r.editedAt !== null,
      isMainText: r.isMainText,
    })),
    topicSuggestions,
    canEdit: editable,
    canApprove: canApproveSermon(actor, facts),
    canRegenerate: editable && sermon.status === 'needs_review',
    approvalProblems: approvalProblems(sermon),
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
