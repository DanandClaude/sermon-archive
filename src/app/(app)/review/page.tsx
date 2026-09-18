import { ComingSoon, PageHeader } from '@/components/shell/PageHeader';
import { requireCapability } from '@/lib/auth/guard';

export const metadata = { title: 'Needs review' };

export default async function ReviewPage() {
  await requireCapability('sermon.review');
  return (
    <>
      <PageHeader
        title="Needs review"
        description="Sermons waiting for you to check the transcript, passages and details before they’re filed."
      />
      <ComingSoon phase="Phase 3" />
    </>
  );
}
