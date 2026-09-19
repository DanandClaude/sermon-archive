import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { auditLog, scriptureRefs, sermonTags, sermons, tags, type ScriptureRef } from '@/db/schema';
import { formatClock } from '@/lib/format';
import { enqueueJob } from '@/lib/jobs';
import { filenameStem, uniqueStem } from '@/lib/naming';
import {
  assertCan,
  canApproveSermon,
  canEditSermon,
  canViewSermon,
  type Actor,
} from '@/lib/permissions';
import {
  formatReference,
  parseReferenceText,
  tagsForBook,
  validateReference,
  type Reference,
} from '@/lib/scripture/canon';
import { isApprovedOrLater } from '@/lib/sermon-status';
import { transitionSermon } from '@/lib/sermons/transition';
import { parseLabelDate } from '@/lib/uploads/label';

export type ReviewCode = 'not_found' | 'forbidden' | 'invalid' | 'conflict';

/** A review action that could not be done. `fieldErrors` names the fields to highlight. */
export class ReviewError extends Error {
  constructor(
    readonly code: ReviewCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Sermon = typeof sermons.$inferSelect;

const NOT_YET = 'Editing opens once processing has finished.';

/**
 * Loads a sermon the actor may edit and locks it for the rest of the transaction. Someone who
 * can't see it is told it doesn't exist; someone who can see it but not change it is told no.
 */
async function editableSermon(tx: Tx, actor: Actor, sermonId: string): Promise<Sermon> {
  assertCan(actor.role, 'library.browse');
  const [sermon] = await tx.select().from(sermons).where(eq(sermons.id, sermonId)).for('update');
  const facts = sermon && {
    contributorId: sermon.contributorId,
    status: sermon.status,
    deleted: sermon.deletedAt !== null,
  };
  if (!sermon || !facts || !canViewSermon(actor, facts)) {
    throw new ReviewError('not_found', 'Sermon not found.');
  }
  if (!canEditSermon(actor, facts))
    throw new ReviewError('forbidden', 'You can’t change this sermon.');
  if (sermon.status !== 'needs_review' && !isApprovedOrLater(sermon.status)) {
    throw new ReviewError('conflict', NOT_YET);
  }
  return sermon;
}

const same = (a: Reference | null, b: Reference | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.book === b.book &&
    a.chapter === b.chapter &&
    a.verseStart === b.verseStart &&
    a.verseEnd === b.verseEnd);

export const asReference = (value: unknown): Reference | null => {
  const v = value as Partial<Reference> | null;
  return v && typeof v.book === 'string' && typeof v.chapter === 'number'
    ? {
        book: v.book,
        chapter: v.chapter,
        verseStart: v.verseStart ?? null,
        verseEnd: v.verseEnd ?? null,
      }
    : null;
};

// -- tags ------------------------------------------------------------------------------------

type TagSpec = { kind: 'testament' | 'genre' | 'book' | 'topic'; name: string };

async function ensureTag(tx: Tx, spec: TagSpec): Promise<string> {
  const find = () =>
    tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.kind, spec.kind), sql`lower(${tags.name}) = lower(${spec.name})`));
  const [existing] = await find();
  if (existing) return existing.id;
  await tx.insert(tags).values(spec).onConflictDoNothing();
  return (await find())[0].id;
}

/** Makes the sermon's tags of the given kinds exactly `wanted`. Other kinds are left alone. */
export async function setTags(
  tx: Tx,
  sermonId: string,
  kinds: TagSpec['kind'][],
  wanted: TagSpec[],
): Promise<void> {
  const ids = new Set<string>();
  for (const spec of wanted) ids.add(await ensureTag(tx, spec));
  const current = await tx
    .select({ tagId: sermonTags.tagId })
    .from(sermonTags)
    .innerJoin(tags, eq(tags.id, sermonTags.tagId))
    .where(and(eq(sermonTags.sermonId, sermonId), inArray(tags.kind, kinds)));
  const stale = current.map((c) => c.tagId).filter((id) => !ids.has(id));
  if (stale.length) {
    await tx
      .delete(sermonTags)
      .where(and(eq(sermonTags.sermonId, sermonId), inArray(sermonTags.tagId, stale)));
  }
  const have = new Set(current.map((c) => c.tagId));
  const missing = [...ids].filter((id) => !have.has(id));
  if (missing.length) {
    await tx
      .insert(sermonTags)
      .values(missing.map((tagId) => ({ sermonId, tagId })))
      .onConflictDoNothing();
  }
}

const passageTags = (ref: Reference | null): TagSpec[] => (ref ? tagsForBook(ref.book) : []);

/** Exactly one live reference, the first one spoken that matches the main passage, is flagged as the main text. */
async function syncMainText(tx: Tx, sermonId: string, primary: Reference | null): Promise<void> {
  await tx
    .update(scriptureRefs)
    .set({ isMainText: false })
    .where(eq(scriptureRefs.sermonId, sermonId));
  if (!primary) return;
  const live = await tx
    .select()
    .from(scriptureRefs)
    .where(and(eq(scriptureRefs.sermonId, sermonId), isNull(scriptureRefs.deletedAt)))
    .orderBy(asc(scriptureRefs.spokenAtSec));
  const match = live.find((r) =>
    same(
      { book: r.book, chapter: r.chapter, verseStart: r.verseStart, verseEnd: r.verseEnd },
      primary,
    ),
  );
  if (match)
    await tx.update(scriptureRefs).set({ isMainText: true }).where(eq(scriptureRefs.id, match.id));
}

const audit = (tx: Tx, actor: Actor, action: string, sermonId: string, diff: unknown) =>
  tx
    .insert(auditLog)
    .values({ actorId: actor.id, action, entity: 'sermon', entityId: sermonId, diff });

// -- details ---------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters.`);

export const detailsSchema = z.object({
  title: text(80).optional(),
  recordedOn: text(40).optional(),
  speaker: text(80).optional(),
  primaryPassage: text(80).optional(),
  topics: z.array(z.string().trim().min(1).max(40)).max(5, 'Use up to 5 topics.').optional(),
});

export type DetailsResult = { changed: string[] };

/**
 * Saves the sermon's details. Only the fields given are changed. The file name is not stored
 * here; it is worked out from these fields when the sermon is approved.
 */
export async function updateDetails(
  db: Db,
  actor: Actor,
  sermonId: string,
  input: unknown,
): Promise<DetailsResult> {
  const parsed = detailsSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    throw new ReviewError('invalid', 'Check the highlighted fields.', fieldErrors);
  }
  const data = parsed.data;

  return db.transaction(async (tx) => {
    const sermon = await editableSermon(tx, actor, sermonId);
    const fieldErrors: Record<string, string> = {};
    const set: Partial<typeof sermons.$inferInsert> = {};
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const note = (field: string, from: unknown, to: unknown) => {
      if (JSON.stringify(from) !== JSON.stringify(to)) diff[field] = { from, to };
    };

    if (data.title !== undefined) {
      const title = data.title || null;
      if (title !== sermon.title) {
        set.title = title;
        note('title', sermon.title, title);
      }
    }
    if (data.speaker !== undefined) {
      const speaker = data.speaker || null;
      if (speaker !== sermon.speaker) {
        set.speaker = speaker;
        note('speaker', sermon.speaker, speaker);
      }
    }
    if (data.recordedOn !== undefined) {
      if (data.recordedOn === '') {
        if (sermon.recordedOn !== null) {
          set.recordedOn = null;
          set.dateSource = null;
          note('recordedOn', sermon.recordedOn, null);
        }
      } else {
        const date = parseLabelDate(data.recordedOn);
        if (!date.ok) fieldErrors.recordedOn = date.error;
        else if (date.iso !== sermon.recordedOn) {
          // What a person types wins over anything detected, and is recorded as a manual entry.
          set.recordedOn = date.iso;
          set.dateSource = 'manual';
          note('recordedOn', sermon.recordedOn, date.iso);
        }
      }
    }

    let newPrimary: Reference | null | undefined;
    if (data.primaryPassage !== undefined) {
      const current = asReference(sermon.primaryPassage);
      if (data.primaryPassage === '') newPrimary = null;
      else {
        const result = parseReferenceText(data.primaryPassage);
        if (!result.ok) fieldErrors.primaryPassage = result.error;
        else newPrimary = result.ref;
      }
      if (newPrimary !== undefined && !same(newPrimary, current)) {
        set.primaryPassage = newPrimary;
        note(
          'primaryPassage',
          current && formatReference(current),
          newPrimary && formatReference(newPrimary),
        );
      } else newPrimary = undefined;
    }
    if (Object.keys(fieldErrors).length)
      throw new ReviewError('invalid', 'Check the highlighted fields.', fieldErrors);

    if (Object.keys(set).length) {
      await tx
        .update(sermons)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(sermons.id, sermonId));
    }
    if (newPrimary !== undefined) {
      await syncMainText(tx, sermonId, newPrimary);
      await setTags(tx, sermonId, ['testament', 'genre', 'book'], passageTags(newPrimary));
    }
    if (data.topics !== undefined) {
      const seen = new Set<string>();
      const topics = data.topics.filter(
        (t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()),
      );
      const before = await topicNames(tx, sermonId);
      await setTags(
        tx,
        sermonId,
        ['topic'],
        topics.map((name) => ({ kind: 'topic', name })),
      );
      note('topics', before, topics);
    }
    const changed = Object.keys(diff);
    if (changed.length) await audit(tx, actor, 'sermon.update', sermonId, diff);
    return { changed };
  });
}

async function topicNames(tx: Tx, sermonId: string): Promise<string[]> {
  const rows = await tx
    .select({ name: tags.name })
    .from(sermonTags)
    .innerJoin(tags, eq(tags.id, sermonTags.tagId))
    .where(and(eq(sermonTags.sermonId, sermonId), eq(tags.kind, 'topic')))
    .orderBy(asc(tags.name));
  return rows.map((r) => r.name);
}

// -- summary ---------------------------------------------------------------------------------

export async function saveSummary(
  db: Db,
  actor: Actor,
  sermonId: string,
  input: unknown,
): Promise<void> {
  const parsed = z
    .string()
    .trim()
    .max(2000, 'Keep the summary under 2,000 characters.')
    .safeParse(input);
  if (!parsed.success)
    throw new ReviewError('invalid', parsed.error.issues[0].message, {
      summary: parsed.error.issues[0].message,
    });
  await db.transaction(async (tx) => {
    const sermon = await editableSermon(tx, actor, sermonId);
    const summary = parsed.data || null;
    if (summary === sermon.summaryText) return;
    await tx
      .update(sermons)
      .set({ summaryText: summary, summarySource: 'edited', updatedAt: new Date() })
      .where(eq(sermons.id, sermonId));
    await audit(tx, actor, 'sermon.summary_edit', sermonId, {
      from: sermon.summaryText,
      to: summary,
    });
  });
}

/** Asks the worker to write the summary again. The sermon goes back to "analyzing" until it is done. */
export async function requestRegenerate(db: Db, actor: Actor, sermonId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const sermon = await editableSermon(tx, actor, sermonId);
    if (sermon.status !== 'needs_review')
      throw new ReviewError('conflict', 'Only a sermon waiting for review can be regenerated.');
    if (!(await transitionSermon(tx, sermonId, 'needs_review', 'analyzing'))) {
      throw new ReviewError(
        'conflict',
        'This sermon changed while you were working. Reload and try again.',
      );
    }
    await enqueueJob(tx, sermonId, 'analyze', { only: 'summary' });
    await audit(tx, actor, 'sermon.regenerate', sermonId, { only: 'summary' });
  });
}

// -- scripture references --------------------------------------------------------------------

export const refInputSchema = z.object({
  book: z.string().trim().min(1, 'Choose a book.'),
  chapter: z.number({ error: 'Enter a chapter number.' }).int('Enter a whole number.'),
  verseStart: z
    .number()
    .int('Enter a whole number.')
    .nullish()
    .transform((v) => v ?? null),
  verseEnd: z
    .number()
    .int('Enter a whole number.')
    .nullish()
    .transform((v) => v ?? null),
  spokenAtSec: z
    .number({ error: 'Enter when it was spoken.' })
    .min(0, 'The time can’t be negative.'),
  contextNote: text(200)
    .nullish()
    .transform((v) => v || null),
  isMainText: z.boolean().default(false),
});

function parseRef(input: unknown, durationSec: number | null) {
  const parsed = refInputSchema.safeParse(input);
  const fieldErrors: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    throw new ReviewError('invalid', 'Check the highlighted fields.', fieldErrors);
  }
  const d = parsed.data;
  const valid = validateReference({
    book: d.book,
    chapter: d.chapter,
    verseStart: d.verseStart,
    verseEnd: d.verseEnd,
  });
  if (!valid.ok) {
    const field =
      /book/i.test(valid.error) && !/has/.test(valid.error)
        ? 'book'
        : /chapter/.test(valid.error)
          ? 'chapter'
          : /ending/.test(valid.error)
            ? 'verseEnd'
            : 'verseStart';
    throw new ReviewError('invalid', valid.error, { [field]: valid.error });
  }
  if (durationSec !== null && d.spokenAtSec > durationSec + 2) {
    const message = 'That time is after the end of the recording.';
    throw new ReviewError('invalid', message, { spokenAtSec: message });
  }
  return {
    ref: valid.ref,
    spokenAtSec: d.spokenAtSec,
    contextNote: d.contextNote,
    isMainText: d.isMainText,
  };
}

const refOf = (r: ScriptureRef): Reference => ({
  book: r.book,
  chapter: r.chapter,
  verseStart: r.verseStart,
  verseEnd: r.verseEnd,
});

async function applyMainChoice(
  tx: Tx,
  sermon: Sermon,
  ref: Reference,
  isMain: boolean,
  wasMain: boolean,
) {
  let primary = asReference(sermon.primaryPassage);
  if (isMain) primary = ref;
  else if (wasMain) primary = null;
  else return syncMainText(tx, sermon.id, primary);
  await tx
    .update(sermons)
    .set({ primaryPassage: primary, updatedAt: new Date() })
    .where(eq(sermons.id, sermon.id));
  await syncMainText(tx, sermon.id, primary);
  await setTags(tx, sermon.id, ['testament', 'genre', 'book'], passageTags(primary));
}

/** A passage appears once. Refuses one that is already in the list, and says where. */
async function assertNotListed(tx: Tx, sermonId: string, ref: Reference, exceptId?: string) {
  const [found] = await tx
    .select({ at: scriptureRefs.spokenAtSec })
    .from(scriptureRefs)
    .where(
      and(
        eq(scriptureRefs.sermonId, sermonId),
        isNull(scriptureRefs.deletedAt),
        exceptId ? ne(scriptureRefs.id, exceptId) : undefined,
        eq(scriptureRefs.book, ref.book),
        eq(scriptureRefs.chapter, ref.chapter),
        sql`${scriptureRefs.verseStart} is not distinct from ${ref.verseStart}`,
        sql`${scriptureRefs.verseEnd} is not distinct from ${ref.verseEnd}`,
      ),
    )
    .orderBy(asc(scriptureRefs.spokenAtSec))
    .limit(1);
  if (found) {
    const message = `${formatReference(ref)} is already in the list, at ${formatClock(found.at)}.`;
    throw new ReviewError('invalid', message, { book: message });
  }
}

/** Adds a passage the system missed. */
export async function addScriptureRef(
  db: Db,
  actor: Actor,
  sermonId: string,
  input: unknown,
): Promise<ScriptureRef> {
  return db.transaction(async (tx) => {
    const sermon = await editableSermon(tx, actor, sermonId);
    const { ref, spokenAtSec, contextNote, isMainText } = parseRef(input, sermon.durationSec);
    await assertNotListed(tx, sermonId, ref);
    const [row] = await tx
      .insert(scriptureRefs)
      .values({
        sermonId,
        ...ref,
        spokenAtSec,
        contextNote,
        source: 'manual',
        editedBy: actor.id,
        editedAt: new Date(),
      })
      .returning();
    await applyMainChoice(tx, sermon, ref, isMainText, false);
    await audit(tx, actor, 'scripture.add', sermonId, {
      ref: formatReference(ref),
      spokenAtSec,
      refId: row.id,
    });
    return row;
  });
}

async function liveRef(tx: Tx, sermonId: string, refId: string): Promise<ScriptureRef> {
  const [row] = await tx
    .select()
    .from(scriptureRefs)
    .where(
      and(
        eq(scriptureRefs.id, refId),
        eq(scriptureRefs.sermonId, sermonId),
        isNull(scriptureRefs.deletedAt),
      ),
    )
    .for('update');
  if (!row) throw new ReviewError('not_found', 'That passage is no longer in the list.');
  return row;
}

/** Corrects a passage. What the system originally found stays on the record in `detectedOriginal`. */
export async function editScriptureRef(
  db: Db,
  actor: Actor,
  sermonId: string,
  refId: string,
  input: unknown,
): Promise<void> {
  await db.transaction(async (tx) => {
    const sermon = await editableSermon(tx, actor, sermonId);
    const before = await liveRef(tx, sermonId, refId);
    const { ref, spokenAtSec, contextNote, isMainText } = parseRef(input, sermon.durationSec);
    await assertNotListed(tx, sermonId, ref, refId);
    const wasMain = same(refOf(before), asReference(sermon.primaryPassage));
    await tx
      .update(scriptureRefs)
      .set({ ...ref, spokenAtSec, contextNote, editedBy: actor.id, editedAt: new Date() })
      .where(eq(scriptureRefs.id, refId));
    await applyMainChoice(tx, sermon, ref, isMainText, wasMain);
    await audit(tx, actor, 'scripture.edit', sermonId, {
      refId,
      from: {
        ref: formatReference(refOf(before)),
        spokenAtSec: before.spokenAtSec,
        contextNote: before.contextNote,
      },
      to: { ref: formatReference(ref), spokenAtSec, contextNote },
    });
  });
}

/** Removes a passage from the list. It is hidden, not erased, and the deletion is audited. */
export async function deleteScriptureRef(
  db: Db,
  actor: Actor,
  sermonId: string,
  refId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const sermon = await editableSermon(tx, actor, sermonId);
    const row = await liveRef(tx, sermonId, refId);
    await tx
      .update(scriptureRefs)
      .set({ deletedAt: new Date(), isMainText: false, editedBy: actor.id, editedAt: new Date() })
      .where(eq(scriptureRefs.id, refId));
    await syncMainText(tx, sermonId, asReference(sermon.primaryPassage));
    await audit(tx, actor, 'scripture.delete', sermonId, {
      refId,
      ref: formatReference(refOf(row)),
      spokenAtSec: row.spokenAtSec,
      source: row.source,
    });
  });
}

/** Drizzle wraps the driver's error, so the Postgres code may be on `cause`. */
const isUniqueViolation = (error: unknown): boolean => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
};

// -- approval --------------------------------------------------------------------------------

/** What still has to be filled in before a sermon can be approved. Also used to disable the button. */
export function approvalProblems(sermon: {
  title: string | null;
  recordedOn: string | null;
  primaryPassage: unknown;
}): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!sermon.recordedOn) problems.recordedOn = 'Add the date from the tape label.';
  if (!asReference(sermon.primaryPassage)) problems.primaryPassage = 'Choose the main passage.';
  if (!sermon.title?.trim()) problems.title = 'Give the sermon a short title.';
  return problems;
}

/**
 * Approves a sermon: checks the required fields, gives it its file name, and marks who approved
 * it and when. Filing to the shared drive and backup is Phase 4.
 */
export async function approveSermon(
  db: Db,
  actor: Actor,
  sermonId: string,
): Promise<{ stem: string }> {
  assertCan(actor.role, 'library.browse');
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [sermon] = await tx
          .select()
          .from(sermons)
          .where(eq(sermons.id, sermonId))
          .for('update');
        const facts = sermon && {
          contributorId: sermon.contributorId,
          status: sermon.status,
          deleted: sermon.deletedAt !== null,
        };
        if (!sermon || !facts || !canViewSermon(actor, facts))
          throw new ReviewError('not_found', 'Sermon not found.');
        if (!canApproveSermon(actor, { ...facts, status: 'needs_review' }))
          throw new ReviewError('forbidden', 'You can’t approve this sermon.');
        if (sermon.status !== 'needs_review')
          throw new ReviewError('conflict', 'This sermon is not waiting for approval.');
        const problems = approvalProblems(sermon);
        if (Object.keys(problems).length)
          throw new ReviewError(
            'invalid',
            'A few things are still needed before approving.',
            problems,
          );

        const [upload] = await tx.execute<{ filename: string }>(
          sql`select filename from uploads where sermon_id = ${sermonId} order by created_at limit 1`,
        );
        const stem = await uniqueStem(
          tx,
          filenameStem({
            recordedOn: sermon.recordedOn,
            passage: asReference(sermon.primaryPassage),
            title: sermon.title,
            batchLabel: sermon.batchLabel,
            originalFilename: upload?.filename,
          }),
          sermonId,
        );
        const moved = await transitionSermon(tx, sermonId, 'needs_review', 'approved', {
          filenameStem: stem,
          approvedAt: new Date(),
          approvedBy: actor.id,
        });
        if (!moved)
          throw new ReviewError(
            'conflict',
            'This sermon changed while you were working. Reload and try again.',
          );
        await enqueueJob(tx, sermonId, 'file');
        await audit(tx, actor, 'sermon.approve', sermonId, { stem });
        return { stem };
      });
    } catch (error) {
      // Someone else took the same file name a moment ago: work out the next free one.
      if (isUniqueViolation(error) && attempt < 3) continue;
      throw error;
    }
  }
}
