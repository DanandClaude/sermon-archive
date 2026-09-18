import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sermons } from '@/db/schema';
import { canViewSermon } from '@/lib/permissions';
import { ROLES } from '@/lib/roles';
import { SERMON_STATUSES, type SermonStatus } from '@/lib/sermon-status';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import { visibleSermons } from './visibility';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

describe('visibleSermons (SQL) agrees with canViewSermon', () => {
  it('for every role, status, owner and deleted flag', async () => {
    const me = await insertUser(db, 'contributor');
    const other = await insertUser(db, 'contributor');
    const rows: { id: string; contributorId: string; status: SermonStatus; deleted: boolean }[] =
      [];
    for (const status of SERMON_STATUSES) {
      for (const owner of [me, other]) {
        for (const deleted of [false, true]) {
          const [row] = await db
            .insert(sermons)
            .values({ contributorId: owner.id, status, deletedAt: deleted ? new Date() : null })
            .returning();
          rows.push({ id: row.id, contributorId: owner.id, status, deleted });
        }
      }
    }
    expect(rows).toHaveLength(SERMON_STATUSES.length * 4);

    for (const role of ROLES) {
      const actor = { id: me.id, role };
      const fromSql = (
        await db.select({ id: sermons.id }).from(sermons).where(visibleSermons(actor))
      ).map((r) => r.id);
      const fromFunction = rows.filter((r) => canViewSermon(actor, r)).map((r) => r.id);
      expect(fromSql.sort(), role).toEqual(fromFunction.sort());
    }
  });

  it('shows a viewer only approved, filing and filed sermons', async () => {
    const owner = await insertUser(db, 'contributor');
    const viewer = await insertUser(db, 'viewer');
    for (const status of SERMON_STATUSES) {
      await db.insert(sermons).values({ contributorId: owner.id, status });
    }
    const seen = await db
      .select({ status: sermons.status })
      .from(sermons)
      .where(visibleSermons(viewer));
    expect(seen.map((r) => r.status).sort()).toEqual(['approved', 'filed', 'filing']);
  });
});
