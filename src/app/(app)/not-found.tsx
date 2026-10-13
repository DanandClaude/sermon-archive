import Link from 'next/link';
import { PageHeader } from '@/components/shell/PageHeader';

/** A sermon that doesn't exist, was removed, or that this person may not see all look the same. */
export default function NotFound() {
  return (
    <>
      <PageHeader
        title="We couldn’t find that"
        description="It may have been removed, or the link may be wrong. If someone sent you this link, ask them to check it."
      />
      <Link
        href="/library"
        className="inline-flex h-11 items-center self-start rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white"
      >
        Go to the library
      </Link>
    </>
  );
}
