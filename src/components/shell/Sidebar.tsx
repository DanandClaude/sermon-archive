import Link from 'next/link';
import { Icon } from '@/components/icons';
import { initials } from '@/lib/initials';
import { ROLE_LABELS, type Role } from '@/lib/roles';
import type { NavSection } from '@/lib/nav';
import { NavLink } from './NavLink';

function subtitle(role: Role, locationLabel: string | null): string {
  if (locationLabel) return `${ROLE_LABELS[role]} · ${locationLabel}`;
  return role === 'admin' ? 'Full access' : ROLE_LABELS[role];
}

export type SidebarProps = {
  churchName: string;
  user: { name: string; role: Role; locationLabel: string | null };
  sections: NavSection[];
  badges: { needsReview: number };
  signOutAction: () => Promise<void>;
};

export function Sidebar({ churchName, user, sections, badges, signOutAction }: SidebarProps) {
  return (
    <aside className="on-sidebar sticky top-0 flex h-screen w-[248px] flex-none flex-col bg-sidebar px-4 py-6 text-sidebar-ink">
      <div className="flex items-center gap-3 px-2 pb-7">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar-ink text-sidebar">
          <Icon name="cassette" size={24} />
        </div>
        <div className="min-w-0">
          <div className="font-heading text-[19px] font-semibold leading-[1.1] text-white">
            Sermon Archive
          </div>
          <div className="mt-[3px] truncate text-[12.5px] text-sidebar-muted">{churchName}</div>
        </div>
      </div>

      {sections.map((section) => (
        <nav key={section.id} aria-label={section.label} className="mb-5 flex flex-col gap-1">
          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-sidebar-muted">
            {section.label}
          </div>
          {section.items.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              badge={item.badge === 'needsReview' ? badges.needsReview : undefined}
            />
          ))}
        </nav>
      ))}

      <div className="flex-1" />
      <div className="flex items-center gap-1 rounded-xl bg-sidebar-card p-1.5">
        <Link
          href="/profile"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1.5 hover:bg-sidebar-active"
        >
          <div
            aria-hidden="true"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-sidebar-ink text-[13px] font-bold text-sidebar"
          >
            {initials(user.name)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{user.name}</div>
            <div className="truncate text-xs text-sidebar-muted">
              {subtitle(user.role, user.locationLabel)}
            </div>
          </div>
        </Link>
        <form action={signOutAction}>
          <button
            type="submit"
            aria-label="Sign out"
            title="Sign out"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-sidebar-body hover:bg-sidebar-active"
          >
            <Icon name="signout" />
          </button>
        </form>
      </div>
    </aside>
  );
}
