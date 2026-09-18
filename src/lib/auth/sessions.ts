import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import type { SessionUser } from './types';
import { generateToken, hashToken } from './tokens';

/** Fixed lifetime: people sign in again with a fresh link after 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(
  db: Db,
  userId: string,
  options: { userAgent?: string | null; now?: Date } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const now = options.now ?? new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, now)));
  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt,
    userAgent: options.userAgent?.slice(0, 300) ?? null,
    createdAt: now,
  });
  return { token, expiresAt };
}

/** Checks the database on every call, so disabling someone signs them out immediately. */
export async function getSessionUser(
  db: Db,
  token: string,
  now = new Date(),
): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      locationLabel: users.locationLabel,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, now), isNull(users.disabledAt)),
    );
  return row ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

export async function deleteUserSessions(db: Pick<Db, 'delete'>, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
