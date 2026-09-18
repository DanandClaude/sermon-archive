import { Sidebar } from '@/components/shell/Sidebar';
import { getDb } from '@/db/client';
import { signOut } from '@/lib/auth/actions';
import { getCurrentUser } from '@/lib/auth/session';
import { navFor } from '@/lib/nav';
import { countNeedsReview } from '@/lib/sermons/library';
import { getSettings } from '@/lib/settings';

// The shell only reads who you are and the church name to draw itself. It does not enforce
// access: layouts don't re-render on client navigation, so each page checks its own permission.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const db = getDb();
  const [{ churchName }, needsReview] = await Promise.all([
    getSettings(db),
    countNeedsReview(db, user),
  ]);

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-10 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-3 focus:font-semibold"
      >
        Skip to content
      </a>
      <Sidebar
        churchName={churchName}
        user={user}
        sections={navFor(user.role)}
        badges={{ needsReview }}
        signOutAction={signOut}
      />
      <main id="main" className="flex min-w-0 flex-1 flex-col gap-7 px-11 pb-8 pt-10">
        {children}
      </main>
    </div>
  );
}
