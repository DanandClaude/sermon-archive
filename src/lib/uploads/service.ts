import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  InvalidPartsError,
  UploadNotFoundError,
  type UploadedPart,
  type UploadStore,
} from '@/adapters/uploads/types';
import type { Db } from '@/db/client';
import { audioAssets, auditLog, sermons, uploads, type Upload } from '@/db/schema';
import { assertCan, type Actor } from '@/lib/permissions';
import { transitionSermon } from '@/lib/sermons/transition';
import { MAX_FILE_BYTES } from './limits';
import { parseLabelDate } from './label';
import { EXTENSION_FORMAT, extensionOf, FORMAT_MIME, sniffAudioFormat } from './sniff';

export { MAX_FILE_BYTES };
export const DEFAULT_PART_BYTES = 8 * 1024 * 1024;
export const PART_URL_TTL_SEC = 15 * 60;

export type UploadErrorCode = 'invalid' | 'not_found' | 'incomplete' | 'not_audio';

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
    readonly missingParts?: number[],
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters.`)
    .nullish()
    .transform((v) => v || null);

/** Rejects path separators and control characters so a file name can never escape its folder. */
function isPlainFilename(name: string): boolean {
  return [...name].every((ch) => ch !== '/' && ch !== '\\' && ch.charCodeAt(0) >= 32);
}

const startSchema = z.object({
  filename: z.string().min(1).max(255).refine(isPlainFilename, 'Invalid file name.'),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'The file is empty.')
    .max(MAX_FILE_BYTES, 'Files can be up to 2 GB.'),
  lastModified: z.number().int().nonnegative(),
  details: z
    .object({
      recordedOn: text(40),
      labelScripture: text(120),
      speaker: text(80),
      batchLabel: text(80),
      side: z
        .enum(['A', 'B'])
        .nullish()
        .transform((v) => v ?? null),
    })
    .optional(),
});

export function fingerprintOf(
  userId: string,
  filename: string,
  sizeBytes: number,
  lastModified: number,
) {
  return createHash('sha256')
    .update(`${userId}|${filename}|${sizeBytes}|${lastModified}`)
    .digest('hex');
}

export type StartResult = {
  uploadId: string;
  sermonId: string;
  partSize: number;
  totalParts: number;
  completedParts: { partNumber: number; size: number }[];
  resumed: boolean;
};

type Deps = { db: Db; store: UploadStore; partSize?: number };

async function existingUpload(db: Db, userId: string, fingerprint: string) {
  const [row] = await db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.userId, userId),
        eq(uploads.fingerprint, fingerprint),
        eq(uploads.status, 'in_progress'),
      ),
    );
  return row;
}

async function describe(
  store: UploadStore,
  upload: Upload,
  resumed: boolean,
): Promise<StartResult> {
  const parts = await store.listParts({ key: upload.storageKey, uploadId: upload.storeUploadId });
  return {
    uploadId: upload.id,
    sermonId: upload.sermonId,
    partSize: upload.partSize,
    totalParts: Math.ceil(upload.sizeBytes / upload.partSize),
    completedParts: parts.map((p) => ({ partNumber: p.partNumber, size: p.size })),
    resumed,
  };
}

async function discard(db: Db, upload: Upload, actorId: string, action: string) {
  await db.transaction(async (tx) => {
    await tx.update(uploads).set({ status: 'aborted' }).where(eq(uploads.id, upload.id));
    await tx.update(sermons).set({ deletedAt: new Date() }).where(eq(sermons.id, upload.sermonId));
    await tx.insert(auditLog).values({
      actorId,
      action,
      entity: 'sermon',
      entityId: upload.sermonId,
      diff: { filename: upload.filename },
    });
  });
}

/**
 * Begins an upload, or picks one back up. Adding the same file again (same name, size and
 * last-modified time) resumes the earlier upload instead of starting over.
 */
export async function startUpload(
  { db, store, partSize = DEFAULT_PART_BYTES }: Deps,
  actor: Actor,
  input: unknown,
): Promise<StartResult> {
  assertCan(actor.role, 'sermon.upload');
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.') || 'file'] ??= issue.message;
    }
    throw new UploadError('invalid', 'Check the highlighted fields.', fieldErrors);
  }
  const { filename, sizeBytes, lastModified, details } = parsed.data;

  const ext = extensionOf(filename);
  const format = EXTENSION_FORMAT[ext];
  if (!format) {
    throw new UploadError('invalid', 'Use an MP3, WAV, M4A, AIFF or FLAC file.', {
      file: 'Unsupported file type.',
    });
  }
  let recordedOn: string | null = null;
  if (details?.recordedOn) {
    const date = parseLabelDate(details.recordedOn);
    if (!date.ok)
      throw new UploadError('invalid', date.error, { 'details.recordedOn': date.error });
    recordedOn = date.iso;
  }

  const fingerprint = fingerprintOf(actor.id, filename, sizeBytes, lastModified);
  const found = await existingUpload(db, actor.id, fingerprint);
  if (found) {
    try {
      return await describe(store, found, true);
    } catch (error) {
      if (!(error instanceof UploadNotFoundError)) throw error;
      // The storage side expired; drop the stale record and start clean.
      await discard(db, found, actor.id, 'sermon.upload_expired');
    }
  }

  const sermonId = crypto.randomUUID();
  const storageKey = `originals/${sermonId}/original.${ext}`;
  const { uploadId: storeUploadId } = await store.createMultipartUpload({
    key: storageKey,
    contentType: FORMAT_MIME[format],
  });
  try {
    const upload = await db.transaction(async (tx) => {
      await tx.insert(sermons).values({
        id: sermonId,
        status: 'uploading',
        contributorId: actor.id,
        recordedOn,
        dateSource: recordedOn ? 'label' : null,
        speaker: details?.speaker ?? null,
        batchLabel: details?.batchLabel ?? null,
        side: details?.side ?? null,
        labelScripture: details?.labelScripture ?? null,
      });
      const [row] = await tx
        .insert(uploads)
        .values({
          sermonId,
          userId: actor.id,
          storageKey,
          storeUploadId,
          filename,
          sizeBytes,
          mime: FORMAT_MIME[format],
          fingerprint,
          partSize,
        })
        .returning();
      return row;
    });
    return await describe(store, upload, false);
  } catch (error) {
    await store.abortMultipartUpload({ key: storageKey, uploadId: storeUploadId }).catch(() => {});
    // Two identical requests raced; the other one won, so join it.
    if ((error as { code?: string })?.code === '23505') {
      const winner = await existingUpload(db, actor.id, fingerprint);
      if (winner) return describe(store, winner, true);
    }
    throw error;
  }
}

async function ownedUpload(db: Db, actor: Actor, uploadId: string): Promise<Upload> {
  // Only the person who started an upload can touch it, whatever their role.
  const [row] = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.userId, actor.id)));
  if (!row) throw new UploadError('not_found', 'Upload not found.');
  return row;
}

export async function presignPartUrl(
  { db, store }: Deps,
  actor: Actor,
  uploadId: string,
  partNumber: number,
): Promise<{ url: string }> {
  assertCan(actor.role, 'sermon.upload');
  const upload = await ownedUpload(db, actor, uploadId);
  const total = Math.ceil(upload.sizeBytes / upload.partSize);
  if (
    upload.status !== 'in_progress' ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > total
  ) {
    throw new UploadError('not_found', 'Upload not found.');
  }
  return store.presignPart({
    key: upload.storageKey,
    uploadId: upload.storeUploadId,
    partNumber,
    expiresInSec: PART_URL_TTL_SEC,
  });
}

function missingParts(upload: Upload, have: UploadedPart[]): number[] {
  const total = Math.ceil(upload.sizeBytes / upload.partSize);
  const missing: number[] = [];
  for (let n = 1; n <= total; n++) {
    const expected = n < total ? upload.partSize : upload.sizeBytes - upload.partSize * (total - 1);
    const part = have.find((p) => p.partNumber === n);
    if (!part || part.size !== expected) missing.push(n);
  }
  return missing;
}

async function sha256Of(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function firstBytes(store: UploadStore, key: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of await store.read(key, { start: 0, end: 63 })) {
    chunks.push(chunk);
    length += chunk.byteLength;
    if (length >= 64) break;
  }
  return Buffer.concat(chunks).subarray(0, 64);
}

/**
 * Checks every part arrived at the right size, assembles the file, confirms it really is audio,
 * records its checksum, and moves the sermon to `uploaded`. Safe to call twice.
 */
export async function completeUpload(
  { db, store }: Deps,
  actor: Actor,
  uploadId: string,
): Promise<{ sermonId: string; status: 'uploaded' }> {
  assertCan(actor.role, 'sermon.upload');
  const upload = await ownedUpload(db, actor, uploadId);
  if (upload.status === 'completed') return { sermonId: upload.sermonId, status: 'uploaded' };
  if (upload.status !== 'in_progress') throw new UploadError('not_found', 'Upload not found.');

  const have = await store.listParts({ key: upload.storageKey, uploadId: upload.storeUploadId });
  const missing = missingParts(upload, have);
  if (missing.length > 0) {
    throw new UploadError('incomplete', 'Some parts did not arrive.', undefined, missing);
  }

  try {
    await store.completeMultipartUpload({
      key: upload.storageKey,
      uploadId: upload.storeUploadId,
      parts: have.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    });
  } catch (error) {
    if (error instanceof InvalidPartsError) throw new UploadError('incomplete', error.message);
    throw error;
  }

  const format = EXTENSION_FORMAT[extensionOf(upload.filename)];
  if (sniffAudioFormat(await firstBytes(store, upload.storageKey)) !== format) {
    // The stored object stays (originals are never deleted); the sermon is withdrawn.
    await discard(db, upload, actor.id, 'sermon.upload_rejected');
    throw new UploadError(
      'not_audio',
      `“${upload.filename}” doesn’t look like a ${format.toUpperCase()} audio file.`,
    );
  }
  const sha256 = await sha256Of(await store.read(upload.storageKey));

  await db.transaction(async (tx) => {
    await tx.insert(audioAssets).values({
      sermonId: upload.sermonId,
      kind: 'original',
      storageKey: upload.storageKey,
      sha256,
      bytes: upload.sizeBytes,
      mime: upload.mime,
      originalFilename: upload.filename,
    });
    await tx
      .update(uploads)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(uploads.id, upload.id));
    if (!(await transitionSermon(tx, upload.sermonId, 'uploading', 'uploaded'))) {
      throw new UploadError('not_found', 'Upload not found.');
    }
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'sermon.upload',
      entity: 'sermon',
      entityId: upload.sermonId,
      diff: { filename: upload.filename, bytes: upload.sizeBytes, sha256 },
    });
  });
  return { sermonId: upload.sermonId, status: 'uploaded' };
}

/** Cancels an unfinished upload. The half-uploaded sermon is hidden; nothing finished is ever deleted. */
export async function abortUpload(
  { db, store }: Deps,
  actor: Actor,
  uploadId: string,
): Promise<void> {
  assertCan(actor.role, 'sermon.upload');
  const upload = await ownedUpload(db, actor, uploadId);
  if (upload.status !== 'in_progress') return;
  await store.abortMultipartUpload({ key: upload.storageKey, uploadId: upload.storeUploadId });
  await discard(db, upload, actor.id, 'sermon.upload_cancelled');
}

export type QueueItem = {
  sermonId: string;
  uploadId: string | null;
  filename: string;
  status: string;
  sizeBytes: number | null;
  createdAt: Date;
};

/** The signed-in user's own sermons that are still moving through the pipeline. */
export async function listQueue(db: Db, actor: Actor, limit = 50): Promise<QueueItem[]> {
  assertCan(actor.role, 'sermon.upload');
  const rows = await db
    .select({
      sermonId: sermons.id,
      uploadId: uploads.id,
      filename: uploads.filename,
      status: sermons.status,
      sizeBytes: uploads.sizeBytes,
      createdAt: sermons.createdAt,
    })
    .from(sermons)
    .leftJoin(uploads, eq(uploads.sermonId, sermons.id))
    .where(
      and(
        eq(sermons.contributorId, actor.id),
        isNull(sermons.deletedAt),
        notInArray(sermons.status, ['approved', 'filing', 'filed']),
      ),
    )
    .orderBy(desc(sermons.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, filename: r.filename ?? 'Untitled tape' }));
}
