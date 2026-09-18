import { connection } from 'next/server';
import { Icon } from '@/components/icons';
import { getDb } from '@/db/client';
import { getSettings } from '@/lib/settings';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Render per request: the church name comes from the database and can change at any time.
  await connection();
  const { churchName } = await getSettings(getDb());
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-10">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar text-sidebar-ink">
          <Icon name="cassette" size={24} />
        </div>
        <div>
          <div className="font-heading text-[19px] font-semibold leading-[1.1]">Sermon Archive</div>
          <div className="mt-[3px] text-[12.5px] text-muted">{churchName}</div>
        </div>
      </div>
      <div className="w-full max-w-[440px] rounded-2xl border border-line bg-surface px-7 py-8">
        {children}
      </div>
    </main>
  );
}
