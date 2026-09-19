import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditLog, jobs, sermons, workerHeartbeats, type Job } from '@/db/schema';
import { STAGE_JOB, type FailedStage, type JobType } from './job-types';
import { canRetrySermon, canViewSermon, type Actor } from './permissions';
import { transitionSermon } from './sermons/transition';

/** After this long without a heartbeat the worker is treated as offline. */
export const WORKER_STALE_SECONDS = 90;

/**
 * Adds a job for the worker. Returns false if that sermon already has a waiting or running job
 * of this type, so enqueueing twice never doubles the work.
 */
export async function enqueueJob(
  db: Pick<Db, 'insert'>,
  sermonId: string,
  type: JobType,
  payload?: Record<string, unknown>,
): Promise<boolean> {
  const rows = await db
    .insert(jobs)
    .values({ sermonId, type, payload: payload ?? null })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows.length === 1;
}

export type RetryResult = { ok: true; stage: FailedStage } | { ok: false; error: string };

/**
 * Puts a failed sermon back into the stage that failed and queues a fresh job for it. The owner
 * (before approval) and admins may retry. Anyone who can't see the sermon is told it doesn't exist,
 * and everyone who can see a failed sermon is allowed to retry it.
 */
export async function retrySermon(db: Db, actor: Actor, sermonId: string): Promise<RetryResult> {
  return db.transaction(async (tx) => {
    const [sermon] = await tx.select().from(sermons).where(eq(sermons.id, sermonId)).for('update');
    const facts = sermon && {
      contributorId: sermon.contributorId,
      status: sermon.status,
      deleted: sermon.deletedAt !== null,
    };
    if (!sermon || !facts || !canViewSermon(actor, facts)) {
      return { ok: false as const, error: 'Sermon not found.' };
    }
    if (!canRetrySermon(actor, facts)) {
      return { ok: false as const, error: 'Only a failed sermon can be retried.' };
    }
    const stage = sermon.failedStage as FailedStage | null;
    const jobType = stage ? STAGE_JOB[stage] : null;
    if (!stage || !jobType) {
      return { ok: false as const, error: 'This stage can’t be retried yet.' };
    }
    const moved = await transitionSermon(tx, sermonId, 'failed', stage, {
      failedStage: null,
      lastError: null,
    });
    if (!moved) return { ok: false as const, error: 'Only a failed sermon can be retried.' };
    await enqueueJob(tx, sermonId, jobType);
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'sermon.retry',
      entity: 'sermon',
      entityId: sermonId,
      diff: { stage },
    });
    return { ok: true as const, stage };
  });
}

export type WorkerStatus = { online: boolean; lastSeenAt: Date | null };

export async function getWorkerStatus(db: Db, now = new Date()): Promise<WorkerStatus> {
  const [row] = await db
    .select({ lastSeenAt: sql<Date | null>`max(${workerHeartbeats.lastSeenAt})` })
    .from(workerHeartbeats);
  const lastSeenAt = row?.lastSeenAt ? new Date(row.lastSeenAt) : null;
  const online =
    lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() < WORKER_STALE_SECONDS * 1000;
  return { online, lastSeenAt };
}

export async function listJobsForSermon(db: Db, sermonId: string): Promise<Job[]> {
  return db.select().from(jobs).where(eq(jobs.sermonId, sermonId)).orderBy(asc(jobs.createdAt));
}

/** Progress (0-100) of the sermon's running job, if any. */
export async function runningProgress(db: Db, sermonId: string): Promise<number | null> {
  const [row] = await db
    .select({ progress: jobs.progress })
    .from(jobs)
    .where(and(eq(jobs.sermonId, sermonId), eq(jobs.state, 'running')))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return row?.progress ?? null;
}
