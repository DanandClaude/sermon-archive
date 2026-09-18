export const ROLES = ['admin', 'contributor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  contributor: 'Contributor',
  viewer: 'Viewer',
};
