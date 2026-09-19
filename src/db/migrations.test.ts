import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, resetTables } from '../../tests/support/db';
import { jobs, sermons, transcripts, users } from './schema';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

describe('migrations', () => {
  it('create every table', async () => {
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'analyses',
      'audio_assets',
      'audit_log',
      'jobs',
      'login_tokens',
      'scripture_refs',
      'sermon_tags',
      'sermons',
      'sessions',
      'settings',
      'tags',
      'transcripts',
      'uploads',
      'users',
      'worker_heartbeats',
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

  it('allow one waiting or running job per sermon and type, but not two', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'a@example.test', name: 'A' })
      .returning();
    const [s] = await db.insert(sermons).values({ contributorId: user.id }).returning();
    await db.insert(jobs).values({ sermonId: s.id, type: 'clean' });
    await expect(db.insert(jobs).values({ sermonId: s.id, type: 'clean' })).rejects.toThrow();
    await db.insert(jobs).values({ sermonId: s.id, type: 'transcribe' });
    await db.update(jobs).set({ state: 'failed' });
    await expect(db.insert(jobs).values({ sermonId: s.id, type: 'clean' })).resolves.toBeDefined();
  });

  it('only allow a real stage in failed_stage', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'b@example.test', name: 'B' })
      .returning();
    await expect(
      db.insert(sermons).values({ contributorId: user.id, failedStage: 'banana' }),
    ).rejects.toThrow();
    await expect(
      db.insert(sermons).values({ contributorId: user.id, failedStage: 'transcribing' }),
    ).resolves.toBeDefined();
  });

  it('keep one transcript per sermon and version', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'c@example.test', name: 'C' })
      .returning();
    const [s] = await db.insert(sermons).values({ contributorId: user.id }).returning();
    const row = {
      sermonId: s.id,
      version: 1,
      model: 'm',
      language: 'en',
      fullText: 'x',
      segments: [],
      lowConfidence: [],
    };
    await db.insert(transcripts).values(row);
    await expect(db.insert(transcripts).values(row)).rejects.toThrow();
    await expect(db.insert(transcripts).values({ ...row, version: 2 })).resolves.toBeDefined();
  });
});
