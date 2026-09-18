import { describe, expect, it } from 'vitest';
import { navFor } from './nav';
import { can } from './permissions';
import { ROLES } from './roles';

const links = (role: Parameters<typeof navFor>[0]) =>
  navFor(role).flatMap((s) => s.items.map((i) => i.label));

describe('navFor', () => {
  it('shows viewers only the library', () => {
    expect(links('viewer')).toEqual(['Library']);
  });

  it('shows contributors the workspace but no Admin section', () => {
    expect(links('contributor')).toEqual(['Upload tapes', 'Library', 'Needs review']);
    expect(navFor('contributor').map((s) => s.id)).toEqual(['workspace']);
  });

  it('shows admins the workspace and the Admin section', () => {
    expect(links('admin')).toEqual([
      'Upload tapes',
      'Library',
      'Needs review',
      'Connections',
      'Team & access',
      'Settings',
    ]);
  });

  it('only ever lists links the role is allowed to use', () => {
    for (const role of ROLES) {
      for (const section of navFor(role)) {
        for (const item of section.items) expect(can(role, item.capability)).toBe(true);
      }
    }
  });
});
