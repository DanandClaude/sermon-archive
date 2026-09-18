import type { Role } from '@/lib/roles';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  locationLabel: string | null;
};
