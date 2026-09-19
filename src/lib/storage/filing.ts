import { and, asc, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import {
  auditLog,
  jobs,
  sermons,
  storageObjects,
  storageTargets,
  verificationRuns,
  type VerificationRun,
} from '@/db/schema';
import { enqueueJob } from '@/lib/jobs';
import { assertCan, canViewSermon, type Actor } from '@/lib/permissions';
import { bothConnected, StorageError, type StorageRole } from './connections';

const NOT_CONNECTED = 'Connect the shared drive and the backup on the Connections page first.';

/**
 * Tries filing again for one approved sermon that has not been filed. Admins only: the usual
 * fix is on the Connections page, which only admins can open.
 */
export async function retryFiling(db: Db, actor: Actor, sermonId: string): Promise<void> {
  assertCan(actor.role, 'connections.manage');
  await db.transaction(async (tx) => {
    const [sermon] = await tx.select().from(sermons).where(eq(sermons.id, sermonId)).for('update');
    if (!sermon || sermon.deletedAt !== null)
      throw new StorageError('not_found', 'Sermon not found.');
    if (sermon.status !== 'approved')
      throw new StorageError(
        'conflict',
        'Only an approved sermon that is waiting to be filed can be filed again.',
      );
    if (!(await bothConnected(tx))) throw new StorageError('conflict', NOT_CONNECTED);
    await tx
      .update(sermons)
      .set({ filingError: null, updatedAt: new Date() })
      .where(eq(sermons.id, sermonId));
    await enqueueJob(tx, sermonId, 'file');
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'sermon.file_retry',
      entity: 'sermon',
      entityId: sermonId,
      diff: null,
    });
  });
}

/** Approved sermons with no filing job waiting or running: what "File waiting sermons" would queue. */
export async function waitingToFile(db: Pick<Db, 'select'>): Promise<string[]> {
  const rows = await db
    .select({ id: sermons.id })
    .from(sermons)
    .where(
      and(
        eq(sermons.status, 'approved'),
        isNull(sermons.deletedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(jobs)
            .where(
              and(
                eq(jobs.sermonId, sermons.id),
                eq(jobs.type, 'file'),
                inArray(jobs.state, ['queued', 'running']),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(sermons.approvedAt));
  return rows.map((r) => r.id);
}

/** Queues filing for every approved sermon that is waiting, once both targets are connected. */
export async function fileWaitingSermons(db: Db, actor: Actor): Promise<number> {
  assertCan(actor.role, 'connections.manage');
  return db.transaction(async (tx) => {
    if (!(await bothConnected(tx))) throw new StorageError('conflict', NOT_CONNECTED);
    const ids = await waitingToFile(tx);
    let queued = 0;
    for (const id of ids) {
      await tx.update(sermons).set({ filingError: null }).where(eq(sermons.id, id));
      if (await enqueueJob(tx, id, 'file')) queued++;
    }
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'storage.file_waiting',
      entity: 'storage_target',
      entityId: null,
      diff: { queued },
    });
    return queued;
  });
}

/** Starts "Verify now", unless a check is already waiting or running (then that one is returned). */
export async function requestVerification(db: Db, actor: Actor): Promise<VerificationRun> {
  assertCan(actor.role, 'connections.manage');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('verification_runs'))`);
    const [open] = await tx
      .select()
      .from(verificationRuns)
      .where(inArray(verificationRuns.state, ['queued', 'running']))
      .limit(1);
    if (open) return open;
    const [run] = await tx
      .insert(verificationRuns)
      .values({ trigger: 'manual', requestedBy: actor.id })
      .returning();
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'storage.verify_requested',
      entity: 'verification_run',
      entityId: run.id,
      diff: null,
    });
    return run;
  });
}

export async function latestVerification(db: Db, actor: Actor): Promise<VerificationRun | null> {
  assertCan(actor.role, 'connections.manage');
  const [run] = await db
    .select()
    .from(verificationRuns)
    .orderBy(desc(verificationRuns.createdAt))
    .limit(1);
  return run ?? null;
}

export type Problem = {
  sermonId: string;
  stem: string | null;
  role: StorageRole;
  path: string;
  state: 'drifted' | 'missing';
  verifiedAt: Date | null;
};

/** Files that no longer match what was filed, for the admin to fix by hand. */
export async function listProblems(db: Db, actor: Actor, limit = 100): Promise<Problem[]> {
  assertCan(actor.role, 'connections.manage');
  const rows = await db
    .select({
      sermonId: storageObjects.sermonId,
      stem: sermons.filenameStem,
      role: storageTargets.role,
      path: storageObjects.path,
      state: storageObjects.state,
      verifiedAt: storageObjects.verifiedAt,
    })
    .from(storageObjects)
    .innerJoin(storageTargets, eq(storageTargets.id, storageObjects.targetId))
    .innerJoin(sermons, eq(sermons.id, storageObjects.sermonId))
    .where(inArray(storageObjects.state, ['drifted', 'missing']))
    .orderBy(asc(storageObjects.path))
    .limit(limit);
  return rows as Problem[];
}

export type FilingSummary = {
  filedAt: Date | null;
  error: string | null;
  /** Admins only: where each copy went. Other roles never learn where the backup is. */
  files: { role: StorageRole; path: string; state: string }[] | null;
};

export async function getFilingSummary(
  db: Db,
  actor: Actor,
  sermonId: string,
): Promise<FilingSummary | null> {
  const [sermon] = await db.select().from(sermons).where(eq(sermons.id, sermonId));
  if (!sermon) return null;
  const facts = {
    contributorId: sermon.contributorId,
    status: sermon.status,
    deleted: sermon.deletedAt !== null,
  };
  if (!canViewSermon(actor, facts)) return null;
  let files: FilingSummary['files'] = null;
  if (actor.role === 'admin') {
    const rows = await db
      .select({ role: storageTargets.role, path: storageObjects.path, state: storageObjects.state })
      .from(storageObjects)
      .innerJoin(storageTargets, eq(storageTargets.id, storageObjects.targetId))
      .where(eq(storageObjects.sermonId, sermonId))
      .orderBy(asc(storageTargets.role), asc(storageObjects.path));
    files = rows;
  }
  return { filedAt: sermon.filedAt, error: sermon.filingError, files };
}
