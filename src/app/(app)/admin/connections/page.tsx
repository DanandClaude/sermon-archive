import { AdminOnlyBadge, ComingSoon, PageHeader } from '@/components/shell/PageHeader';
import { requireCapability } from '@/lib/auth/guard';

export const metadata = { title: 'Connections' };

export default async function ConnectionsPage() {
  await requireCapability('connections.manage');
  return (
    <>
      <PageHeader
        title="Connections"
        description="Choose where sermons are stored, where the backup lives, and where they’re shared with the world."
        aside={<AdminOnlyBadge />}
      />
      <ComingSoon phase="Phase 4" />
    </>
  );
}
