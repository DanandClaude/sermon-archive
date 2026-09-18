import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, resetTables } from '../../tests/support/db';
import { users } from './schema';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

describe('migrations', () => {
  it('create the Phase 0 and Phase 1 tables', async () => {
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'audio_assets',
      'audit_log',
      'login_tokens',
      'sermons',
      'sessions',
      'settings',
      'uploads',
      'users',
    ]);
  });

  it('create the role enum', async () => {
    const rows = await db.execute<{ enumlabel: string }>(
      sql`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'user_role' order by e.enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(['admin', 'contributor', 'viewer']);
  });

  it('treat emails as case-insensitively unique', async () => {
    await db.insert(users).values({ email: 'Ann@Example.test', name: 'Ann' });
    await expect(
      db.insert(users).values({ email: 'ann@example.test', name: 'Ann 2' }),
    ).rejects.toThrow();
  });

  it('default new users to the least-privileged role', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'new@example.test', name: 'New' })
      .returning();
    expect(user.role).toBe('viewer');
  });
});
