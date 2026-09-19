'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import type { SessionUser } from '@/lib/auth/session';
import {
  addScriptureRef,
  approveSermon,
  deleteScriptureRef,
  editScriptureRef,
  requestRegenerate,
  ReviewError,
  saveSummary,
  updateDetails,
} from '@/lib/review/service';
import { isUuid } from '@/lib/sermons/detail';

export type ActionResult<T = object> =
  ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Every review action starts here: sign-in and the review capability are checked, then the
 * service decides whether this person may change this sermon. Nothing about who may do what is
 * decided in the browser.
 */
async function run<T extends object>(
  sermonId: string,
  work: (user: SessionUser) => Promise<T>,
): Promise<ActionResult<T>> {
  const user = await requireCapability('sermon.review');
  if (!isUuid(sermonId)) return { ok: false, error: 'Sermon not found.' };
  try {
    const result = await work(user);
    revalidatePath(`/sermons/${sermonId}`);
    revalidatePath('/library');
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof ReviewError) {
      return { ok: false, error: error.message, fieldErrors: error.fieldErrors };
    }
    throw error;
  }
}

export async function saveDetailsAction(sermonId: string, input: unknown) {
  return run(sermonId, async (user) => updateDetails(getDb(), user, sermonId, input));
}

export async function saveSummaryAction(sermonId: string, summary: string) {
  return run(sermonId, async (user) => {
    await saveSummary(getDb(), user, sermonId, summary);
    return {};
  });
}

export async function regenerateSummaryAction(sermonId: string) {
  return run(sermonId, async (user) => {
    await requestRegenerate(getDb(), user, sermonId);
    return {};
  });
}

export async function addPassageAction(sermonId: string, input: unknown) {
  return run(sermonId, async (user) => {
    const row = await addScriptureRef(getDb(), user, sermonId, input);
    return { id: row.id };
  });
}

export async function editPassageAction(sermonId: string, refId: string, input: unknown) {
  return run(sermonId, async (user) => {
    await editScriptureRef(getDb(), user, sermonId, refId, input);
    return {};
  });
}

export async function deletePassageAction(sermonId: string, refId: string) {
  return run(sermonId, async (user) => {
    await deleteScriptureRef(getDb(), user, sermonId, refId);
    return {};
  });
}

export async function approveAction(sermonId: string) {
  return run(sermonId, async (user) => approveSermon(getDb(), user, sermonId));
}
