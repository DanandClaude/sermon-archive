import 'server-only';
import { forbidden } from 'next/navigation';
import { can, type Capability } from '@/lib/permissions';
import { getCurrentUser, type SessionUser } from './session';

/**
 * Call at the top of every page and server action that needs a capability. Layouts don't
 * re-render on client navigation, so a layout check is not enough. Renders the 403 page.
 */
export async function requireCapability(capability: Capability): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!can(user.role, capability)) forbidden();
  return user;
}
