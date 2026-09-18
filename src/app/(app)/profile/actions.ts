'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { getCurrentUser } from '@/lib/auth/session';
import { updateOwnProfile, type FieldErrors } from '@/lib/team';

export type ProfileFormState = {
  status: 'idle' | 'saved' | 'error';
  values: { name: string; locationLabel: string };
  fieldErrors?: FieldErrors;
};

export async function saveProfile(
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const user = await getCurrentUser();
  const values = {
    name: String(formData.get('name') ?? ''),
    locationLabel: String(formData.get('locationLabel') ?? ''),
  };
  // Only the signed-in user's own row is ever touched, and only these two fields.
  const result = await updateOwnProfile(getDb(), user, values);
  if (!result.ok) return { status: 'error', values, fieldErrors: result.fieldErrors };
  revalidatePath('/', 'layout');
  return {
    status: 'saved',
    values: { name: values.name.trim(), locationLabel: values.locationLabel.trim() },
  };
}
