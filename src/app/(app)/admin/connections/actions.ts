'use server';

import { revalidatePath } from 'next/cache';
import { join } from 'node:path';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import {
  connectLocalFolder,
  disconnectTarget,
  isRole,
  StorageError,
} from '@/lib/storage/connections';
import { fileWaitingSermons, requestVerification } from '@/lib/storage/filing';
import { isRealMode } from '@/lib/storage/google-client';

export type StorageActionResult = { ok: true; message?: string } | { ok: false; error: string };

/** Every action here is for admins only, checked on the server before anything else happens. */
async function run(
  work: (user: Awaited<ReturnType<typeof requireCapability>>) => Promise<string | void>,
) {
  const user = await requireCapability('connections.manage');
  try {
    const message = await work(user);
    revalidatePath('/admin/connections');
    return { ok: true, message: message ?? undefined } as const;
  } catch (error) {
    if (error instanceof StorageError) return { ok: false, error: error.message } as const;
    throw error;
  }
}

/** Development only: files to a folder on this machine instead of a Google account. */
export async function connectDevFolderAction(role: string): Promise<StorageActionResult> {
  return run(async (user) => {
    if (isRealMode())
      throw new StorageError(
        'invalid',
        'Use Google Drive here; development folders are for testing.',
      );
    if (!isRole(role)) throw new StorageError('invalid', 'Choose the shared drive or the backup.');
    await connectLocalFolder(getDb(), user, role, join(process.cwd(), '.data', 'targets', role));
  });
}

export async function disconnectAction(role: string): Promise<StorageActionResult> {
  return run(async (user) => {
    if (!isRole(role)) throw new StorageError('invalid', 'Choose the shared drive or the backup.');
    await disconnectTarget(getDb(), user, role);
  });
}

export async function verifyNowAction(): Promise<StorageActionResult> {
  return run(async (user) => {
    await requestVerification(getDb(), user);
  });
}

export async function fileWaitingAction(): Promise<StorageActionResult> {
  return run(async (user) => {
    const queued = await fileWaitingSermons(getDb(), user);
    return queued === 0
      ? 'Nothing was waiting.'
      : `Filing ${queued} ${queued === 1 ? 'sermon' : 'sermons'}.`;
  });
}
