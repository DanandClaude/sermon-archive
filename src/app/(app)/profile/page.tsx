import { PageHeader } from '@/components/shell/PageHeader';
import { getCurrentUser } from '@/lib/auth/session';
import { ROLE_LABELS } from '@/lib/roles';
import { ProfileForm } from './ProfileForm';

export const metadata = { title: 'Your profile' };

export default async function ProfilePage() {
  const user = await getCurrentUser();
  return (
    <>
      <PageHeader
        title="Your profile"
        description="How your name and location appear to your team."
      />
      <ProfileForm
        initial={{ name: user.name, locationLabel: user.locationLabel ?? '' }}
        email={user.email}
        roleLabel={ROLE_LABELS[user.role]}
      />
    </>
  );
}
