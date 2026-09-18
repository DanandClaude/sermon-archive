import type { IconName } from '@/components/icons';
import { can, type Capability } from './permissions';
import type { Role } from './roles';

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  capability: Capability;
  /** Shows the amber count badge when the count is above zero. */
  badge?: 'needsReview';
};

export type NavSection = { id: 'workspace' | 'admin'; label: string; items: NavItem[] };

const NAV: readonly NavSection[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { href: '/upload', label: 'Upload tapes', icon: 'upload', capability: 'sermon.upload' },
      { href: '/library', label: 'Library', icon: 'library', capability: 'library.browse' },
      {
        href: '/review',
        label: 'Needs review',
        icon: 'review',
        capability: 'sermon.review',
        badge: 'needsReview',
      },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    items: [
      {
        href: '/admin/connections',
        label: 'Connections',
        icon: 'connections',
        capability: 'connections.manage',
      },
      { href: '/admin/team', label: 'Team & access', icon: 'team', capability: 'team.manage' },
      {
        href: '/admin/settings',
        label: 'Settings',
        icon: 'settings',
        capability: 'settings.manage',
      },
    ],
  },
];

/** Nav for a role. This only shapes the UI; each page still enforces its own permission. */
export function navFor(role: Role): NavSection[] {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(role, item.capability)),
  })).filter((section) => section.items.length > 0);
}
