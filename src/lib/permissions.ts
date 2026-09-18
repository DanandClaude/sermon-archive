import { ForbiddenError } from './errors';
import type { Role } from './roles';
import { isApprovedOrLater, type SermonStatus } from './sermon-status';

/**
 * Role-level capabilities, from the SPEC §2 matrix. Anything that depends on who owns a
 * sermon is a function below instead. Every server route, action and job checks these;
 * hiding a link is never the enforcement.
 */
export const CAPABILITY_ROLES = {
  'library.browse': ['viewer', 'contributor', 'admin'],
  'sermon.upload': ['contributor', 'admin'],
  'sermon.review': ['contributor', 'admin'],
  'sermon.editAfterApproval': ['admin'],
  'sermon.publish': ['admin'],
  'vault.open': ['admin'],
  'connections.manage': ['admin'],
  'team.manage': ['admin'],
  'settings.manage': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITY_ROLES;

export function can(role: Role, capability: Capability): boolean {
  return (CAPABILITY_ROLES[capability] as readonly Role[]).includes(role);
}

export function assertCan(role: Role, capability: Capability): void {
  if (!can(role, capability)) throw new ForbiddenError();
}

export type Actor = { id: string; role: Role };
export type SermonFacts = { contributorId: string; status: SermonStatus; deleted?: boolean };

/**
 * Viewers see approved sermons only. Contributors see their own drafts plus approved
 * sermons. Admins see everything. (Owner decision, 2026-09-18.)
 */
export function canViewSermon(actor: Actor, sermon: SermonFacts): boolean {
  if (sermon.deleted) return false;
  if (actor.role === 'admin') return true;
  if (isApprovedOrLater(sermon.status)) return true;
  return actor.role === 'contributor' && sermon.contributorId === actor.id;
}

/**
 * Before approval: the uploading contributor and admins. After approval: admins only.
 * Contributors cannot edit each other's uploads. This is the D2 default and is still
 * awaiting the owner's confirmation.
 */
export function canEditSermon(actor: Actor, sermon: SermonFacts): boolean {
  if (actor.role === 'admin') return true;
  if (actor.role !== 'contributor') return false;
  return sermon.contributorId === actor.id && !isApprovedOrLater(sermon.status);
}

/**
 * D1 (confirmed): contributors approve their own sermons; admins can approve any.
 * Keep approval behind this one function so a sign-off step can be added later.
 */
export function canApproveSermon(actor: Actor, sermon: SermonFacts): boolean {
  if (sermon.status !== 'needs_review') return false;
  if (actor.role === 'admin') return true;
  return actor.role === 'contributor' && sermon.contributorId === actor.id;
}
