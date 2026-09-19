import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, jobs, sermons, workerHeartbeats } from '@/db/schema';
import { enqueueJob, getWorkerStatus, retrySermon, WORKER_STALE_SECONDS } from './jobs';
import type { SermonStatus } from './sermon-status';
import { insertUser, openTestDb, resetTables } from '../../tests/support/db';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

type Owner = Awaited<ReturnType<typeof insertUser>>;
async function failedSermon(
  owner: Owner,
  stage: string | null = 'transcribing',
  status: SermonStatus = 'failed',
) {
  const [s] = await db
    .insert(sermons)
    .values({ contributorId: owner.id, status, failedStage: stage, lastError: 'boom' })
    .returning();
  return s;
}
const jobsFor = (sermonId: string) => db.select().from(jobs).where(eq(jobs.sermonId, sermonId));

describe('enqueueJob', () => {
  it('adds a queued job', async () => {
    const owner = await insertUser(db, 'contributor');
    const [s] = await db.insert(sermons).values({ contributorId: owner.id }).returning();
    expect(await enqueueJob(db, s.id, 'clean')).toBe(true);
    expect(await jobsFor(s.id)).toMatchObject([
      { type: 'clean', state: 'queued', attempts: 0, maxAttempts: 3, progress: 0 },
    ]);
  });

  it('does not double up while a job of that type is waiting or running', async () => {
    const owner = await insertUser(db, 'contributor');
    const [s] = await db.insert(sermons).values({ contributorId: owner.id }).returning();
    expect(await enqueueJob(db, s.id, 'clean')).toBe(true);
    expect(await enqueueJob(db, s.id, 'clean')).toBe(false);
    await db.update(jobs).set({ state: 'running' }).where(eq(jobs.sermonId, s.id));
    expect(await enqueueJob(db, s.id, 'clean')).toBe(false);
    expect(await jobsFor(s.id)).toHaveLength(1);
  });

  it('allows a new job once the earlier one has finished or failed, and a different type alongside', async () => {
    const owner = await insertUser(db, 'contributor');
    const [s] = await db.insert(sermons).values({ contributorId: owner.id }).returning();
    await enqueueJob(db, s.id, 'clean');
    await db.update(jobs).set({ state: 'failed' }).where(eq(jobs.sermonId, s.id));
    expect(await enqueueJob(db, s.id, 'clean')).toBe(true);
    expect(await enqueueJob(db, s.id, 'transcribe')).toBe(true);
    expect(await jobsFor(s.id)).toHaveLength(3);
  });
});

describe('retrySermon', () => {
  it('lets the uploader retry: back to the failed stage, error cleared, fresh job queued, audited', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await failedSermon(owner, 'transcribing');
    expect(await retrySermon(db, owner, s.id)).toEqual({ ok: true, stage: 'transcribing' });
    const [after] = await db.select().from(sermons).where(eq(sermons.id, s.id));
    expect(after).toMatchObject({ status: 'transcribing', failedStage: null, lastError: null });
    expect(await jobsFor(s.id)).toMatchObject([
      { type: 'transcribe', state: 'queued', attempts: 0 },
    ]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'sermon.retry'));
    expect(entry).toMatchObject({
      actorId: owner.id,
      entityId: s.id,
      diff: { stage: 'transcribing' },
    });
  });

  it('retries a cleaning failure with a clean job', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await failedSermon(owner, 'cleaning');
    await retrySermon(db, owner, s.id);
    expect((await jobsFor(s.id))[0].type).toBe('clean');
    expect((await db.select().from(sermons).where(eq(sermons.id, s.id)))[0].status).toBe(
      'cleaning',
    );
  });

  it('lets an admin retry anyone’s failed sermon', async () => {
    const owner = await insertUser(db, 'contributor');
    const admin = await insertUser(db, 'admin');
    const s = await failedSermon(owner);
    expect(await retrySermon(db, admin, s.id)).toMatchObject({ ok: true });
  });

  it('refuses another contributor, who cannot even see the draft, and a viewer', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const s = await failedSermon(owner);
    expect(await retrySermon(db, other, s.id)).toEqual({ ok: false, error: 'Sermon not found.' });
    expect(await retrySermon(db, viewer, s.id)).toEqual({ ok: false, error: 'Sermon not found.' });
    expect(await jobsFor(s.id)).toHaveLength(0);
    expect((await db.select().from(sermons).where(eq(sermons.id, s.id)))[0].status).toBe('failed');
  });

  it('gives a plain error for a sermon that is visible but not failed', async () => {
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    const [approved] = await db
      .insert(sermons)
      .values({ contributorId: owner.id, status: 'approved' })
      .returning();
    expect(await retrySermon(db, viewer, approved.id)).toEqual({
      ok: false,
      error: 'Only a failed sermon can be retried.',
    });
  });

  it('only retries sermons that are actually failed', async () => {
    const owner = await insertUser(db, 'contributor');
    const [s] = await db
      .insert(sermons)
      .values({ contributorId: owner.id, status: 'needs_review' })
      .returning();
    expect(await retrySermon(db, owner, s.id)).toEqual({
      ok: false,
      error: 'Only a failed sermon can be retried.',
    });
    expect(await jobsFor(s.id)).toHaveLength(0);
  });

  it('retries an analysis failure with an analyze job', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await failedSermon(owner, 'analyzing');
    expect(await retrySermon(db, owner, s.id)).toEqual({ ok: true, stage: 'analyzing' });
    expect((await jobsFor(s.id))[0].type).toBe('analyze');
    expect((await db.select().from(sermons).where(eq(sermons.id, s.id)))[0].status).toBe(
      'analyzing',
    );
  });

  it('does nothing for a deleted or unknown sermon', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await failedSermon(owner);
    await db.update(sermons).set({ deletedAt: new Date() }).where(eq(sermons.id, s.id));
    expect(await retrySermon(db, owner, s.id)).toEqual({ ok: false, error: 'Sermon not found.' });
    expect(await retrySermon(db, owner, crypto.randomUUID())).toEqual({
      ok: false,
      error: 'Sermon not found.',
    });
  });

  it('when pressed several times at once, queues exactly one job', async () => {
    const owner = await insertUser(db, 'contributor');
    const s = await failedSermon(owner);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => retrySermon(db, owner, s.id)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await jobsFor(s.id)).toHaveLength(1);
  });
});

describe('getWorkerStatus', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const beat = (workerId: string, secondsAgo: number) =>
    db
      .insert(workerHeartbeats)
      .values({ workerId, lastSeenAt: new Date(now.getTime() - secondsAgo * 1000) });

  it('is offline when no worker has ever checked in', async () => {
    expect(await getWorkerStatus(db, now)).toEqual({ online: false, lastSeenAt: null });
  });

  it('is online while a heartbeat is recent, and offline once it goes stale', async () => {
    await beat('mac', 10);
    expect((await getWorkerStatus(db, now)).online).toBe(true);
    await db.delete(workerHeartbeats);
    await beat('mac', WORKER_STALE_SECONDS + 1);
    const status = await getWorkerStatus(db, now);
    expect(status.online).toBe(false);
    expect(status.lastSeenAt).toEqual(new Date(now.getTime() - (WORKER_STALE_SECONDS + 1) * 1000));
  });

  it('is online if any one of several workers is alive', async () => {
    await beat('old', 3600);
    await beat('new', 5);
    expect((await getWorkerStatus(db, now)).online).toBe(true);
  });
});
