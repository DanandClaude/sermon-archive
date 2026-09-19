import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  jobs,
  sermons,
  storageObjects,
  storageTargets,
  verificationRuns,
} from '@/db/schema';
import { ForbiddenError } from '@/lib/errors';
import { decryptJson } from '@/lib/secrets';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import {
  bothConnected,
  connectGoogleDrive,
  connectLocalFolder,
  disconnectTarget,
  listTargets,
  StorageError,
} from './connections';
import {
  fileWaitingSermons,
  getFilingSummary,
  latestVerification,
  listProblems,
  requestVerification,
  retryFiling,
  waitingToFile,
} from './filing';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

const admin = () => insertUser(db, 'admin');
const rejects = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error, 'expected an error').toBeInstanceOf(StorageError);
  expect((error as StorageError).code).toBe(code);
  return error as StorageError;
};

async function connectBoth(a: Awaited<ReturnType<typeof admin>>) {
  await connectGoogleDrive(db, a, 'shared', { refreshToken: 'r1', email: 'shared@example.org' });
  await connectGoogleDrive(db, a, 'backup', { refreshToken: 'r2', email: 'backup@example.org' });
}

async function approvedSermon(
  owner: { id: string },
  over: Partial<typeof sermons.$inferInsert> = {},
) {
  const [s] = await db
    .insert(sermons)
    .values({
      contributorId: owner.id,
      status: 'approved',
      title: 'T',
      recordedOn: '1988-03-13',
      filenameStem: `stem-${crypto.randomUUID()}`,
      approvedAt: new Date(),
      ...over,
    })
    .returning();
  return s;
}

describe('connecting targets', () => {
  it('stores the credentials encrypted, never in the clear', async () => {
    const a = await admin();
    await connectGoogleDrive(db, a, 'shared', {
      refreshToken: 'super-secret-refresh-token',
      email: 'Shared@Example.org',
    });
    const [row] = await db.select().from(storageTargets);
    expect(row.encryptedConfig).not.toContain('super-secret-refresh-token');
    expect(decryptJson(row.encryptedConfig!)).toEqual({
      kind: 'google_drive',
      refreshToken: 'super-secret-refresh-token',
    });
    expect(row).toMatchObject({
      role: 'shared',
      provider: 'google_drive',
      accountLabel: 'Shared@Example.org',
      rootFolderName: 'Sermon Archive',
      connectedBy: a.id,
    });
  });

  it('never shows credentials in the status list', async () => {
    const a = await admin();
    await connectBoth(a);
    const targets = await listTargets(db, a);
    expect(JSON.stringify(targets)).not.toMatch(/r1|r2|encrypted/i);
    expect(targets.map((t) => [t.role, t.connected, t.accountLabel])).toEqual([
      ['shared', true, 'shared@example.org'],
      ['backup', true, 'backup@example.org'],
    ]);
  });

  it('lists both targets as not connected before anything is set up', async () => {
    const a = await admin();
    const targets = await listTargets(db, a);
    expect(targets.map((t) => [t.role, t.connected, t.rootFolderName])).toEqual([
      ['shared', false, 'Sermon Archive'],
      ['backup', false, 'Sermon Archive Backup'],
    ]);
    expect(await bothConnected(db)).toBe(false);
  });

  it('keeps the shared drive and the backup on different accounts', async () => {
    const a = await admin();
    await connectGoogleDrive(db, a, 'shared', { refreshToken: 'r', email: 'church@example.org' });
    const error = await rejects(
      connectGoogleDrive(db, a, 'backup', { refreshToken: 'r', email: 'CHURCH@example.org' }),
      'conflict',
    );
    expect(error.message).toContain('different account');
    expect(await db.select().from(storageTargets)).toHaveLength(1);
  });

  it('lets the same account be used again once the other target is disconnected', async () => {
    const a = await admin();
    await connectBoth(a);
    await disconnectTarget(db, a, 'shared');
    await expect(
      connectGoogleDrive(db, a, 'backup', { refreshToken: 'r', email: 'backup@example.org' }),
    ).resolves.toBeUndefined();
  });

  it('reconnecting the same account keeps its folder; a new account is refused once files are filed', async () => {
    const a = await admin();
    await connectBoth(a);
    const [target] = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.role, 'shared'));
    await db
      .update(storageTargets)
      .set({ rootFolderId: 'folder-1' })
      .where(eq(storageTargets.id, target.id));
    const s = await approvedSermon(a);
    await db.insert(storageObjects).values({
      sermonId: s.id,
      targetId: target.id,
      kind: 'metadata',
      path: 'p',
      remoteId: 'r',
      bytes: 1,
      sha256: 'x',
      remoteChecksum: 'y',
      checksumAlgorithm: 'md5',
    });
    await connectGoogleDrive(db, a, 'shared', {
      refreshToken: 'new-token',
      email: 'shared@example.org',
    });
    expect(
      (await db.select().from(storageTargets).where(eq(storageTargets.id, target.id)))[0]
        .rootFolderId,
    ).toBe('folder-1');
    const error = await rejects(
      connectGoogleDrive(db, a, 'shared', { refreshToken: 'r', email: 'someone.else@example.org' }),
      'conflict',
    );
    expect(error.message).toContain('shared@example.org');
  });

  it('a new account can be connected while nothing has been filed, and resets the folder', async () => {
    const a = await admin();
    await connectGoogleDrive(db, a, 'shared', { refreshToken: 'r', email: 'old@example.org' });
    await db.update(storageTargets).set({ rootFolderId: 'folder-1' });
    await connectGoogleDrive(db, a, 'shared', { refreshToken: 'r', email: 'new@example.org' });
    const [row] = await db.select().from(storageTargets);
    expect([row.accountLabel, row.rootFolderId]).toEqual(['new@example.org', null]);
  });

  it('can connect a development folder', async () => {
    const a = await admin();
    await connectLocalFolder(db, a, 'shared', '/tmp/x/shared');
    const [row] = await db.select().from(storageTargets);
    expect(row.provider).toBe('local');
    expect(decryptJson(row.encryptedConfig!)).toEqual({ kind: 'local', path: '/tmp/x/shared' });
  });

  it('audits connecting and disconnecting, without secrets', async () => {
    const a = await admin();
    await connectBoth(a);
    await disconnectTarget(db, a, 'backup');
    const entries = await db.select().from(auditLog);
    expect(entries.map((e) => e.action).sort()).toEqual([
      'storage.connect',
      'storage.connect',
      'storage.disconnect',
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/"r1"|"r2"|refreshToken/);
  });
});

describe('disconnecting', () => {
  it('wipes the credentials but remembers the account and keeps the filed records', async () => {
    const a = await admin();
    await connectBoth(a);
    await disconnectTarget(db, a, 'shared');
    const [row] = await db.select().from(storageTargets).where(eq(storageTargets.role, 'shared'));
    expect([row.encryptedConfig, row.accountLabel]).toEqual([null, 'shared@example.org']);
    expect(row.disconnectedAt).not.toBeNull();
    expect((await listTargets(db, a))[0].connected).toBe(false);
    expect(await bothConnected(db)).toBe(false);
  });

  it('says so when there is nothing to disconnect', async () => {
    const a = await admin();
    await rejects(disconnectTarget(db, a, 'shared'), 'not_found');
    await connectBoth(a);
    await disconnectTarget(db, a, 'shared');
    await rejects(disconnectTarget(db, a, 'shared'), 'not_found');
  });
});

describe('only admins may touch storage', () => {
  it.each(['contributor', 'viewer'] as const)('refuses a %s everywhere', async (role) => {
    const user = await insertUser(db, role);
    const a = await admin();
    const s = await approvedSermon(a);
    const attempts = [
      () => listTargets(db, user),
      () => connectGoogleDrive(db, user, 'shared', { refreshToken: 'r', email: 'x@example.org' }),
      () => connectLocalFolder(db, user, 'backup', '/tmp/x'),
      () => disconnectTarget(db, user, 'shared'),
      () => retryFiling(db, user, s.id),
      () => fileWaitingSermons(db, user),
      () => requestVerification(db, user),
      () => latestVerification(db, user),
      () => listProblems(db, user),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.select().from(storageTargets)).toHaveLength(0);
    expect(await db.select().from(verificationRuns)).toHaveLength(0);
  });
});

describe('filing sermons', () => {
  it('retrying needs both targets connected, and an approved sermon', async () => {
    const a = await admin();
    const s = await approvedSermon(a);
    await rejects(retryFiling(db, a, s.id), 'conflict');
    await connectBoth(a);
    const draft = await approvedSermon(a, { status: 'needs_review' });
    await rejects(retryFiling(db, a, draft.id), 'conflict');
    await rejects(retryFiling(db, a, crypto.randomUUID()), 'not_found');
    const gone = await approvedSermon(a, { deletedAt: new Date() });
    await rejects(retryFiling(db, a, gone.id), 'not_found');
  });

  it('queues one filing job, clears the error, and audits it', async () => {
    const a = await admin();
    await connectBoth(a);
    const s = await approvedSermon(a, { filingError: 'It broke.' });
    await retryFiling(db, a, s.id);
    await retryFiling(db, a, s.id);
    expect(await db.select().from(jobs).where(eq(jobs.sermonId, s.id))).toMatchObject([
      { type: 'file', state: 'queued' },
    ]);
    expect((await db.select().from(sermons).where(eq(sermons.id, s.id)))[0].filingError).toBeNull();
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, 'sermon.file_retry')),
    ).toHaveLength(2);
  });

  it('files every waiting approved sermon at once, and skips ones already queued', async () => {
    const a = await admin();
    const one = await approvedSermon(a);
    const two = await approvedSermon(a);
    await approvedSermon(a, { status: 'needs_review' });
    await approvedSermon(a, { status: 'filed' });
    await approvedSermon(a, { deletedAt: new Date() });
    await rejects(fileWaitingSermons(db, a), 'conflict'); // not connected yet
    await connectBoth(a);
    await db.insert(jobs).values({ sermonId: two.id, type: 'file' });
    expect((await waitingToFile(db)).sort()).toEqual([one.id]);
    expect(await fileWaitingSermons(db, a)).toBe(1);
    expect(await fileWaitingSermons(db, a)).toBe(0);
    expect((await db.select().from(jobs)).map((j) => j.sermonId).sort()).toEqual(
      [one.id, two.id].sort(),
    );
  });
});

describe('verification runs', () => {
  it('queues one run at a time', async () => {
    const a = await admin();
    const first = await requestVerification(db, a);
    const second = await requestVerification(db, a);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ trigger: 'manual', state: 'queued', requestedBy: a.id });
    await db.update(verificationRuns).set({ state: 'done' });
    const third = await requestVerification(db, a);
    expect(third.id).not.toBe(first.id);
    expect((await latestVerification(db, a))!.id).toBe(third.id);
  });

  it('several presses at once make one run', async () => {
    const a = await admin();
    await Promise.all(Array.from({ length: 5 }, () => requestVerification(db, a)));
    expect(await db.select().from(verificationRuns)).toHaveLength(1);
  });
});

describe('what files no longer match', () => {
  it('lists drifted and missing files with where they are', async () => {
    const a = await admin();
    await connectBoth(a);
    const [shared, backup] = await db.select().from(storageTargets).orderBy(storageTargets.role);
    const s = await approvedSermon(a, { filenameStem: '1988-03-13_Hebrews-13-17_Submitting' });
    const row = {
      sermonId: s.id,
      kind: 'metadata',
      remoteId: 'r',
      bytes: 1,
      sha256: 'x',
      remoteChecksum: 'y',
      checksumAlgorithm: 'md5',
    };
    await db.insert(storageObjects).values([
      { ...row, targetId: shared.id, path: 'a.json', state: 'verified' },
      { ...row, targetId: backup.id, path: 'b.json', state: 'drifted' },
      { ...row, targetId: shared.id, path: 'c.json', state: 'missing' },
    ]);
    const problems = await listProblems(db, a);
    expect(problems.map((p) => [p.role, p.path, p.state, p.stem])).toEqual([
      ['backup', 'b.json', 'drifted', '1988-03-13_Hebrews-13-17_Submitting'],
      ['shared', 'c.json', 'missing', '1988-03-13_Hebrews-13-17_Submitting'],
    ]);
  });
});

describe('the filing summary on a sermon', () => {
  it('tells an admin where each copy went, and never tells anyone else', async () => {
    const a = await admin();
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    await connectBoth(a);
    const [shared] = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.role, 'shared'));
    const s = await approvedSermon(owner, { status: 'filed', filedAt: new Date() });
    await db.insert(storageObjects).values({
      sermonId: s.id,
      targetId: shared.id,
      kind: 'metadata',
      path: '1980s/1988/x/x.json',
      remoteId: 'r',
      bytes: 1,
      sha256: 'x',
      remoteChecksum: 'y',
      checksumAlgorithm: 'md5',
      state: 'verified',
    });
    expect((await getFilingSummary(db, a, s.id))!.files).toEqual([
      { role: 'shared', path: '1980s/1988/x/x.json', state: 'verified' },
    ]);
    for (const who of [owner, viewer]) {
      const summary = await getFilingSummary(db, who, s.id);
      expect(summary!.files).toBeNull();
      expect(summary!.filedAt).not.toBeNull();
    }
  });

  it('is hidden from someone who cannot see the sermon', async () => {
    const owner = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const draft = await approvedSermon(owner, { status: 'needs_review' });
    expect(await getFilingSummary(db, other, draft.id)).toBeNull();
    expect(await getFilingSummary(db, other, crypto.randomUUID())).toBeNull();
  });
});
