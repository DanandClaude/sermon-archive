import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { FAILED_STAGES, JOB_STATES, JOB_TYPES } from '../lib/job-types';
import { ROLES } from '../lib/roles';
import { SERMON_STATUSES } from '../lib/sermon-status';

export const userRole = pgEnum('user_role', ROLES);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: userRole('role').notNull().default('viewer'),
    locationLabel: text('location_label'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    invitedBy: uuid('invited_by').references((): AnyPgColumn => users.id),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`)],
);

/** Server-side sessions. `id` is the SHA-256 of the cookie value, so a database leak is not a login. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** One-time sign-in links. Only the SHA-256 of the token is stored. */
export const loginTokens = pgTable(
  'login_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('login_tokens_user_idx').on(t.userId, t.createdAt)],
);

/** Key/value settings. Known keys and their validation live in src/lib/settings.ts. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Null for system actions (jobs, nightly verification).
    actorId: uuid('actor_id').references(() => users.id),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    diff: jsonb('diff'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entity, t.entityId),
    index('audit_log_at_idx').on(t.at),
  ],
);

export const sermonStatus = pgEnum('sermon_status', SERMON_STATUSES);
export const dateSource = pgEnum('date_source', ['label', 'audio', 'manual']);

/** Fields the analysis and review phases add (summary, tags, passages) arrive with those phases. */
export const sermons = pgTable(
  'sermons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: sermonStatus('status').notNull().default('uploading'),
    title: text('title'),
    recordedOn: date('recorded_on', { mode: 'string' }),
    dateSource: dateSource('date_source'),
    speaker: text('speaker'),
    batchLabel: text('batch_label'),
    side: text('side'),
    /** Scripture exactly as the contributor typed it from the tape label. Parsed in Phase 3. */
    labelScripture: text('label_scripture'),
    durationSec: integer('duration_sec'),
    /** Set with status `failed`: the stage to resume from when someone presses Retry. */
    failedStage: text('failed_stage'),
    lastError: text('last_error'),
    contributorId: uuid('contributor_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('sermons_side_check', sql`${t.side} in ('A', 'B')`),
    check(
      'sermons_failed_stage_check',
      sql`${t.failedStage} is null or ${t.failedStage} in (${sql.raw(FAILED_STAGES.map((s) => `'${s}'`).join(', '))})`,
    ),
    index('sermons_status_idx').on(t.status),
    index('sermons_contributor_idx').on(t.contributorId),
    index('sermons_recorded_on_idx').on(t.recordedOn),
    index('sermons_created_at_idx').on(t.createdAt),
  ],
);

export const audioKind = pgEnum('audio_kind', ['original', 'cleaned', 'video_render']);

/** Immutable once written. Originals are never overwritten or deleted. */
export const audioAssets = pgTable(
  'audio_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sermonId: uuid('sermon_id')
      .notNull()
      .references(() => sermons.id),
    kind: audioKind('kind').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    sha256: text('sha256').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    originalFilename: text('original_filename').notNull(),
    durationSec: integer('duration_sec'),
    peaksKey: text('peaks_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audio_assets_sermon_idx').on(t.sermonId),
    uniqueIndex('audio_assets_one_original_idx')
      .on(t.sermonId)
      .where(sql`${t.kind} = 'original'`),
  ],
);

export const uploadStatus = pgEnum('upload_status', ['in_progress', 'completed', 'aborted']);

/** A resumable multipart upload from the browser straight to object storage. */
export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sermonId: uuid('sermon_id')
      .notNull()
      .references(() => sermons.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    storageKey: text('storage_key').notNull().unique(),
    /** The object store's own multipart upload id. */
    storeUploadId: text('store_upload_id').notNull(),
    filename: text('filename').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    /** Hash of user + name + size + last-modified, so re-adding the same file resumes it. */
    fingerprint: text('fingerprint').notNull(),
    partSize: integer('part_size').notNull(),
    status: uploadStatus('status').notNull().default('in_progress'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uploads_resume_idx')
      .on(t.userId, t.fingerprint)
      .where(sql`${t.status} = 'in_progress'`),
    index('uploads_sermon_idx').on(t.sermonId),
  ],
);

export const jobType = pgEnum('job_type', JOB_TYPES);
export const jobState = pgEnum('job_state', JOB_STATES);

/**
 * Work for the Python worker. The app enqueues; the worker claims with FOR UPDATE SKIP LOCKED,
 * so several workers never take the same job. Each stage is idempotent and writes new assets.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sermonId: uuid('sermon_id')
      .notNull()
      .references(() => sermons.id),
    type: jobType('type').notNull(),
    state: jobState('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Backoff: a queued job is not claimed before this time. */
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    /** 0-100, updated by the worker while running. */
    progress: integer('progress').notNull().default(0),
    lastError: text('last_error'),
    lockedBy: text('locked_by'),
    /** Refreshed while running; a running job with an old heartbeat is treated as abandoned. */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('jobs_claim_idx').on(t.state, t.runAfter),
    index('jobs_sermon_idx').on(t.sermonId),
    // At most one waiting or running job per sermon and type, so enqueueing twice is harmless.
    uniqueIndex('jobs_one_active_idx')
      .on(t.sermonId, t.type)
      .where(sql`${t.state} in ('queued', 'running')`),
  ],
);

/** Word-timed transcript. Each run writes a new version; the highest version is current. */
export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sermonId: uuid('sermon_id')
      .notNull()
      .references(() => sermons.id),
    version: integer('version').notNull(),
    model: text('model').notNull(),
    language: text('language').notNull(),
    fullText: text('full_text').notNull(),
    /** [{ start, end, text, words: [{ w, start, end, prob }] }] */
    segments: jsonb('segments').notNull(),
    /** [[segmentIndex, wordIndex], ...] for words below the confidence threshold. */
    lowConfidence: jsonb('low_confidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('transcripts_sermon_version_idx').on(t.sermonId, t.version)],
);

/** One row per worker, refreshed every few seconds, so the app can say when nothing is processing. */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  info: jsonb('info'),
});

export type User = typeof users.$inferSelect;
export type Sermon = typeof sermons.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Transcript = typeof transcripts.$inferSelect;
export type { Role as UserRole } from '../lib/roles';
