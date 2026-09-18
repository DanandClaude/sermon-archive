import Link from 'next/link';
import { PageHeader } from '@/components/shell/PageHeader';

export default function Forbidden() {
  return (
    <>
      <PageHeader
        title="You don’t have access to this page"
        description="Your role doesn’t include it. If you think it should, ask an admin at your church."
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
