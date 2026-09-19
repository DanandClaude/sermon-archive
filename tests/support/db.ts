import { sql } from 'drizzle-orm';
import { createDb, type Db } from '@/db/client';
import { users } from '@/db/schema';
import type { Role } from '@/lib/roles';
import { testDatabaseUrl } from './test-db';

export function openTestDb(): Db {
  return createDb(testDatabaseUrl());
}

export async function resetTables(db: Db): Promise<void> {
  await db.execute(
    sql`truncate table analyses, scripture_refs, sermon_tags, tags, worker_heartbeats, transcripts, jobs, uploads, audio_assets, sermons, login_tokens, sessions, audit_log, settings, users restart identity cascade`,
  );
}

export async function insertUser(
  db: Db,
  role: Role,
  overrides: Partial<typeof users.$inferInsert> = {},
) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${role}-${crypto.randomUUID()}@example.test`,
      name: `${role} user`,
      role,
      ...overrides,
    })
    .returning();
  return user;
}
