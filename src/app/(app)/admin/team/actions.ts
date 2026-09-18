'use server';

import { revalidatePath } from 'next/cache';
import { getMailer } from '@/adapters';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { sendInvite } from '@/lib/auth/login';
import { getEnv } from '@/lib/env';
import { ROLES, type Role } from '@/lib/roles';
import { getSettings } from '@/lib/settings';
import { changeRole, inviteUser, setUserDisabled, type FieldErrors } from '@/lib/team';

export type TeamFormState = {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  fieldErrors?: FieldErrors;
};

async function emailInvite(userId: string, inviterName: string): Promise<boolean> {
  const db = getDb();
  const { churchName } = await getSettings(db);
  try {
    await sendInvite(db, getMailer(), {
      userId,
      inviterName,
      appUrl: getEnv().APP_URL,
      churchName,
    });
    return true;
  } catch (error) {
    console.error('Could not send invite email', error);
    return false;
  }
}

export async function inviteMember(
  _previous: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  // Server actions are public endpoints, so check the permission here as well as on the page.
  const actor = await requireCapability('team.manage');
  const result = await inviteUser(getDb(), actor, {
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    locationLabel: String(formData.get('locationLabel') ?? ''),
    role: String(formData.get('role') ?? ''),
  });
  if (!result.ok)
    return { status: 'error', fieldErrors: result.fieldErrors, message: result.error };
  revalidatePath('/admin/team');
  const sent = await emailInvite(result.value.id, actor.name);
  return sent
    ? { status: 'ok', message: `Added ${result.value.name} and emailed them a sign-in link.` }
    : {
        status: 'error',
        message: `Added ${result.value.name}, but the email could not be sent. Use “Resend invite” to try again.`,
      };
}

export async function manageMember(
  _previous: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  const actor = await requireCapability('team.manage');
  const userId = String(formData.get('userId') ?? '');
  const intent = String(formData.get('intent') ?? '');
  const db = getDb();

  let outcome: { ok: true; message: string } | { ok: false; error?: string };
  if (intent === 'role') {
    const role = String(formData.get('role') ?? '') as Role;
    const result = ROLES.includes(role)
      ? await changeRole(db, actor, userId, role)
      : { ok: false as const, error: 'Choose a role.' };
    outcome = result.ok ? { ok: true, message: 'Role updated.' } : result;
  } else if (intent === 'disable' || intent === 'enable') {
    const result = await setUserDisabled(db, actor, userId, intent === 'disable');
    outcome = result.ok
      ? { ok: true, message: intent === 'disable' ? 'Disabled. They are signed out.' : 'Enabled.' }
      : result;
  } else if (intent === 'resend') {
    const sent = await emailInvite(userId, actor.name);
    outcome = sent
      ? { ok: true, message: 'Sign-in link sent.' }
      : { ok: false, error: 'The email could not be sent.' };
  } else {
    return { status: 'error', message: 'Unknown action.' };
  }
  revalidatePath('/admin/team');
  return outcome.ok
    ? { status: 'ok', message: outcome.message }
    : { status: 'error', message: outcome.error ?? 'Something went wrong.' };
}
