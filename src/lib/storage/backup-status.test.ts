import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '@/db/schema';
import { ForbiddenError } from '@/lib/errors';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import { getBackupState } from './backup-status';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

const NOW = new Date('2026-09-21T12:00:00Z');
const save = (value: unknown) => db.insert(settings).values({ key: 'backup_last', value });
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('getBackupState', () => {
  it('says nothing has been backed up when the backup service has never reported', async () => {
    const admin = await insertUser(db, 'admin');
    expect(await getBackupState(db, admin, NOW)).toEqual({ kind: 'none' });
  });

  it('reports a recent good backup', async () => {
    const admin = await insertUser(db, 'admin');
    await save({ ok: true, at: hoursAgo(5), bytes: 2_400_000, encrypted: true });
    expect(await getBackupState(db, admin, NOW)).toMatchObject({
      kind: 'ok',
      bytes: 2_400_000,
      encrypted: true,
    });
  });

  it('warns when the last good backup is over a day and a half old', async () => {
    const admin = await insertUser(db, 'admin');
    await save({ ok: true, at: hoursAgo(40), bytes: 1, encrypted: false });
    expect((await getBackupState(db, admin, NOW)).kind).toBe('stale');
  });

  it('shows why the last backup failed', async () => {
    const admin = await insertUser(db, 'admin');
    await save({ ok: false, at: hoursAgo(1), error: 'pg_dump failed: connection refused' });
    expect(await getBackupState(db, admin, NOW)).toMatchObject({
      kind: 'failed',
      error: 'pg_dump failed: connection refused',
    });
  });

  it('treats a damaged record as no backup rather than crashing', async () => {
    const admin = await insertUser(db, 'admin');
    await save({ ok: true, at: 'yesterday-ish' });
    expect(await getBackupState(db, admin, NOW)).toEqual({ kind: 'none' });
  });

  it('is for admins only', async () => {
    const contributor = await insertUser(db, 'contributor');
    await expect(getBackupState(db, contributor, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
