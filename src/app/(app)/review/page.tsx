import { redirect } from 'next/navigation';
import { requireCapability } from '@/lib/auth/guard';

/** "Needs review" in the sidebar is the library filtered to sermons waiting for review. */
export default async function ReviewPage() {
  await requireCapability('sermon.review');
  redirect('/library?tab=needs_review');
}
