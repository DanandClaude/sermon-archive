import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireCapability = vi.fn();
const revalidatePath = vi.fn();
const isRealMode = vi.fn();
const connectLocalFolder = vi.fn();
const disconnectTarget = vi.fn();
const fileWaitingSermons = vi.fn();
const requestVerification = vi.fn();
vi.mock('@/lib/auth/guard', () => ({ requireCapability }));
vi.mock('@/db/client', () => ({ getDb: () => ({ db: true }) }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/storage/google-client', () => ({ isRealMode }));
vi.mock('@/lib/storage/filing', () => ({ fileWaitingSermons, requestVerification }));
vi.mock('@/lib/storage/connections', async (original) => ({
  ...(await original<typeof import('@/lib/storage/connections')>()),
  connectLocalFolder,
  disconnectTarget,
}));

const actions = await import('./actions');
const { StorageError } = await import('@/lib/storage/connections');
const admin = { id: 'a1', role: 'admin' };

describe('connection actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCapability.mockResolvedValue(admin);
    isRealMode.mockReturnValue(false);
  });

  it('every one checks the connections capability first and does nothing if it fails', async () => {
    requireCapability.mockRejectedValue(new Error('NEXT_HTTP_ERROR_FALLBACK;403'));
    for (const call of [
      () => actions.connectDevFolderAction('shared'),
      () => actions.disconnectAction('shared'),
      () => actions.verifyNowAction(),
      () => actions.fileWaitingAction(),
    ]) {
      await expect(call()).rejects.toThrow(/403/);
    }
    expect(requireCapability).toHaveBeenCalledWith('connections.manage');
    for (const fn of [
      connectLocalFolder,
      disconnectTarget,
      fileWaitingSermons,
      requestVerification,
    ])
      expect(fn).not.toHaveBeenCalled();
  });

  it('connects a development folder at a fixed place, never one the caller chose', async () => {
    expect(await actions.connectDevFolderAction('backup')).toEqual({ ok: true });
    expect(connectLocalFolder).toHaveBeenCalledWith(
      { db: true },
      admin,
      'backup',
      join(process.cwd(), '.data', 'targets', 'backup'),
    );
    expect(revalidatePath).toHaveBeenCalledWith('/admin/connections');
  });

  it('refuses development folders in production, and unknown roles', async () => {
    isRealMode.mockReturnValue(true);
    expect(await actions.connectDevFolderAction('shared')).toMatchObject({ ok: false });
    isRealMode.mockReturnValue(false);
    expect(await actions.connectDevFolderAction('../etc')).toMatchObject({ ok: false });
    expect(await actions.disconnectAction('root')).toMatchObject({ ok: false });
    expect(connectLocalFolder).not.toHaveBeenCalled();
    expect(disconnectTarget).not.toHaveBeenCalled();
  });

  it('turns a storage refusal into a message and does not refresh', async () => {
    disconnectTarget.mockRejectedValue(
      new StorageError('not_found', 'That target is not connected.'),
    );
    expect(await actions.disconnectAction('shared')).toEqual({
      ok: false,
      error: 'That target is not connected.',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('lets unexpected errors through', async () => {
    requestVerification.mockRejectedValue(new Error('db down'));
    await expect(actions.verifyNowAction()).rejects.toThrow('db down');
  });

  it('says how many sermons were queued for filing', async () => {
    fileWaitingSermons.mockResolvedValueOnce(3).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    expect(await actions.fileWaitingAction()).toEqual({ ok: true, message: 'Filing 3 sermons.' });
    expect(await actions.fileWaitingAction()).toEqual({
      ok: true,
      message: 'Nothing was waiting.',
    });
    expect(await actions.fileWaitingAction()).toEqual({ ok: true, message: 'Filing 1 sermon.' });
  });
});
