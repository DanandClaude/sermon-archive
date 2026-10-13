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
import {
  connectTestYouTube,
  disconnectChannel,
  DistributionError,
  saveLibrarySettings,
  savePodcastSettings,
  saveYouTubeSettings,
} from '@/lib/distribution/channels';
import { isChannelKind } from '@/lib/distribution/states';
import { fileWaitingSermons, requestVerification } from '@/lib/storage/filing';
import { isRealMode } from '@/lib/storage/google-client';

export type StorageActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

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
    if (error instanceof DistributionError)
      return { ok: false, error: error.message, fieldErrors: error.fieldErrors } as const;
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

/** Development only: a stand-in YouTube channel that "uploads" to a folder on this machine. */
export async function connectTestYouTubeAction(): Promise<StorageActionResult> {
  return run(async (user) => {
    if (isRealMode())
      throw new DistributionError('invalid', 'Sign in with Google to connect a real channel.');
    await connectTestYouTube(getDb(), user);
  });
}

export async function disconnectChannelAction(kind: string): Promise<StorageActionResult> {
  return run(async (user) => {
    if (!isChannelKind(kind))
      throw new DistributionError('invalid', 'Choose YouTube, the podcast or the library.');
    await disconnectChannel(getDb(), user, kind);
  });
}

export async function saveYouTubeSettingsAction(input: unknown): Promise<StorageActionResult> {
  return run(async (user) => {
    await saveYouTubeSettings(getDb(), user, input);
    return 'Saved.';
  });
}

export async function savePodcastSettingsAction(input: unknown): Promise<StorageActionResult> {
  return run(async (user) => {
    await savePodcastSettings(getDb(), user, input);
    return 'Saved. The feed shows the new details within a few minutes.';
  });
}

export async function saveLibrarySettingsAction(input: unknown): Promise<StorageActionResult> {
  return run(async (user) => {
    await saveLibrarySettings(getDb(), user, input);
    return 'Saved.';
  });
}
