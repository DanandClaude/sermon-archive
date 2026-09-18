'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/icons';

export function NavLink({
  href,
  label,
  icon,
  badge,
}: {
  href: string;
  label: string;
  icon: IconName;
  /** Shown as an amber pill when above zero. */
  badge?: number;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex h-11 items-center gap-3 rounded-[10px] px-3 text-[14.5px] ${
        active
          ? 'bg-sidebar-active font-semibold text-white'
          : 'font-medium text-sidebar-body hover:bg-sidebar-card'
      }`}
    >
      <Icon name={icon} />
      {label}
      {badge ? (
        <span
          aria-label={`${badge} waiting`}
          className="ml-auto rounded-full bg-amber px-2 py-0.5 text-xs font-bold text-ink"
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
