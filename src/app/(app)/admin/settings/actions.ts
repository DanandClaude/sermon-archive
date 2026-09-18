'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { updateSettings, type AppSettings } from '@/lib/settings';

export type SettingsFormState = {
  status: 'idle' | 'saved' | 'error';
  values: AppSettings;
  errors?: Partial<Record<keyof AppSettings, string>>;
};

export async function saveSettings(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  // Server actions are public endpoints, so check permission here, not just on the page.
  const user = await requireCapability('settings.manage');
  const values = {
    churchName: String(formData.get('churchName') ?? ''),
    defaultSpeaker: String(formData.get('defaultSpeaker') ?? ''),
  };
  const result = await updateSettings(getDb(), user, values);
  if (!result.ok) return { status: 'error', values, errors: result.errors };
  revalidatePath('/', 'layout');
  return {
    status: 'saved',
    values: { churchName: values.churchName.trim(), defaultSpeaker: values.defaultSpeaker.trim() },
  };
}
