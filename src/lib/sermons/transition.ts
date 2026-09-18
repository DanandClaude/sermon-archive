import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { sermons } from '@/db/schema';
import { assertTransition, type SermonStatus } from '@/lib/sermon-status';

/**
 * Compare-and-set: moves a sermon from `from` to `to` only if it is still in `from`. Returns
 * false when something else changed it first, so two workers can never both advance it.
 * Throws InvalidTransitionError for a move the state machine doesn't allow.
 */
export async function transitionSermon(
  db: Pick<Db, 'update'>,
  sermonId: string,
  from: SermonStatus,
  to: SermonStatus,
): Promise<boolean> {
  assertTransition(from, to);
  const rows = await db
    .update(sermons)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(sermons.id, sermonId), eq(sermons.status, from)))
    .returning({ id: sermons.id });
  return rows.length === 1;
}
