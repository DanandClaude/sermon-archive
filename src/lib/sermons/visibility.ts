import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { sermons } from '@/db/schema';
import type { Actor } from '@/lib/permissions';
import { SERMON_STATUSES, isApprovedOrLater } from '@/lib/sermon-status';

const APPROVED_STATUSES = SERMON_STATUSES.filter(isApprovedOrLater);

/**
 * The SQL twin of canViewSermon. Visibility is enforced in the query itself, so hidden sermons
 * are never fetched and pagination counts stay honest. A test checks the two never disagree.
 */
export function visibleSermons(actor: Actor): SQL {
  const notDeleted = isNull(sermons.deletedAt);
  if (actor.role === 'admin') return notDeleted;
  const approved = inArray(sermons.status, APPROVED_STATUSES);
  if (actor.role === 'contributor') {
    return and(notDeleted, or(approved, eq(sermons.contributorId, actor.id)))!;
  }
  return and(notDeleted, approved)!;
}
