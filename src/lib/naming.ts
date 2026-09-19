import { and, eq, isNull, like, ne, or } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { sermons } from '@/db/schema';
import { withSuffix } from './naming-core';

export * from './naming-core';

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A stem no other live sermon is using. The unique index in the database is the final guard. */
export async function uniqueStem(
  db: Pick<Db, 'select'>,
  stem: string,
  sermonId: string,
): Promise<string> {
  const taken = new Set(
    (
      await db
        .select({ stem: sermons.filenameStem })
        .from(sermons)
        .where(
          and(
            isNull(sermons.deletedAt),
            ne(sermons.id, sermonId),
            or(
              eq(sermons.filenameStem, stem),
              like(sermons.filenameStem, `${escapeLike(stem)}\\_%`),
            ),
          ),
        )
    ).map((r) => r.stem),
  );
  for (let n = 1; ; n++) {
    const candidate = withSuffix(stem, n);
    if (!taken.has(candidate)) return candidate;
  }
}
