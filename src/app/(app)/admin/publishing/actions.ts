'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import type { SessionUser } from '@/lib/auth/session';
import { DistributionError } from '@/lib/distribution/channels';
import {
  requestPublish,
  requestUnpublish,
  retryPublication,
  type PublicationSummary,
  type PublishRequest,
} from '@/lib/distribution/publications';
import { isUuid } from '@/lib/sermons/detail';

export type PublishActionResult =
  | { ok: true; publication: PublicationSummary }
  | { ok: false; error: string; needsConfirmation?: boolean };

/**
 * Publishing is for admins only, checked on the server before anything else. The service then
 * decides whether this sermon may be published.
 */
async function run(
  work: (user: SessionUser) => Promise<PublicationSummary>,
): Promise<PublishActionResult> {
  const user = await requireCapability('sermon.publish');
  try {
    const publication = await work(user);
    revalidatePath('/admin/publishing');
    revalidatePath('/sermons/[id]', 'page');
    return { ok: true, publication };
  } catch (error) {
    if (error instanceof DistributionError)
      return { ok: false, error: error.message, needsConfirmation: error.code === 'confirm' };
    throw error;
  }
}

export async function publishAction(
  sermonId: string,
  input: PublishRequest,
): Promise<PublishActionResult> {
  if (!isUuid(sermonId)) return { ok: false, error: 'Sermon not found.' };
  return run((user) => requestPublish(getDb(), user, sermonId, input));
}

export async function unpublishAction(publicationId: string): Promise<PublishActionResult> {
  if (!isUuid(publicationId)) return { ok: false, error: 'That publication was not found.' };
  return run((user) => requestUnpublish(getDb(), user, publicationId));
}

export async function retryPublicationAction(publicationId: string): Promise<PublishActionResult> {
  if (!isUuid(publicationId)) return { ok: false, error: 'That publication was not found.' };
  return run((user) => retryPublication(getDb(), user, publicationId));
}
