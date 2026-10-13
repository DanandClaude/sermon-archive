import { AdminOnlyBadge, PageHeader } from '@/components/shell/PageHeader';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { getSettings } from '@/lib/settings';
import { SettingsForm } from './SettingsForm';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  await requireCapability('settings.manage');
  const settings = await getSettings(getDb());
  return (
    <>
      <PageHeader
        title="Settings"
        description="Your church’s name, the speaker suggested for new uploads, and words to help transcription."
        aside={<AdminOnlyBadge />}
      />
      <SettingsForm initial={settings} />
    </>
  );
}
