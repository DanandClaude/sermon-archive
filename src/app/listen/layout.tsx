import Link from 'next/link';
import { connection } from 'next/server';
import { Icon } from '@/components/icons';
import { getDb } from '@/db/client';
import { getLibraryInfo, LIBRARY_PATH } from '@/lib/distribution/library';

/** The public online library. No sign-in; the pages show only what an admin published. */
export default async function ListenLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const info = await getLibraryInfo(getDb());
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[860px] items-center gap-3 px-4 py-4">
          <div className="flex size-10 flex-none items-center justify-center rounded-xl bg-sidebar text-sidebar-ink">
            <Icon name="cassette" size={24} />
          </div>
          <div className="min-w-0">
            <Link
              href={LIBRARY_PATH}
              className="block font-heading text-[19px] font-semibold leading-[1.15] text-ink no-underline"
            >
              {info?.title ?? 'Sermon library'}
            </Link>
            {info ? <div className="mt-0.5 text-[12.5px] text-muted">{info.churchName}</div> : null}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[860px] px-4 pb-16 pt-6">{children}</main>
    </div>
  );
}
