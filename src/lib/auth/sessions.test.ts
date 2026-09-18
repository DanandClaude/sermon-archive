import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sessions, users } from '@/db/schema';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  getSessionUser,
  SESSION_TTL_MS,
} from './sessions';
import { hashToken } from './tokens';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

describe('sessions', () => {
  it('signs a user in and returns who they are', async () => {
    const user = await insertUser(db, 'contributor', {
      name: 'Marcy T.',
      locationLabel: 'Tulsa, OK',
    });
    const { token } = await createSession(db, user.id);
    expect(await getSessionUser(db, token)).toEqual({
      id: user.id,
      email: user.email,
      name: 'Marcy T.',
      role: 'contributor',
      locationLabel: 'Tulsa, OK',
    });
  });

  it('stores only a hash of the cookie value', async () => {
    const user = await insertUser(db, 'viewer');
    const { token } = await createSession(db, user.id);
    const [row] = await db.select().from(sessions);
    expect(row.id).toBe(hashToken(token));
    expect(row.id).not.toBe(token);
  });

  it('rejects an unknown token', async () => {
    await insertUser(db, 'viewer');
    expect(await getSessionUser(db, 'nope')).toBeNull();
  });

  it('expires after 30 days', async () => {
    const user = await insertUser(db, 'viewer');
    const now = new Date('2026-01-01T00:00:00Z');
    const { token, expiresAt } = await createSession(db, user.id, { now });
    expect(expiresAt.getTime() - now.getTime()).toBe(SESSION_TTL_MS);
    expect(await getSessionUser(db, token, new Date(expiresAt.getTime() - 1))).not.toBeNull();
    expect(await getSessionUser(db, token, expiresAt)).toBeNull();
  });

  it('stops working the moment the user is disabled', async () => {
    const user = await insertUser(db, 'contributor');
    const { token } = await createSession(db, user.id);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    expect(await getSessionUser(db, token)).toBeNull();
  });

  it('reflects a role change straight away', async () => {
    const user = await insertUser(db, 'admin');
    const { token } = await createSession(db, user.id);
    await db.update(users).set({ role: 'viewer' }).where(eq(users.id, user.id));
    expect((await getSessionUser(db, token))?.role).toBe('viewer');
  });

  it('signs out one session or all of a user’s sessions', async () => {
    const user = await insertUser(db, 'viewer');
    const a = await createSession(db, user.id);
    const b = await createSession(db, user.id);
    await deleteSession(db, a.token);
    expect(await getSessionUser(db, a.token)).toBeNull();
    expect(await getSessionUser(db, b.token)).not.toBeNull();
    await deleteUserSessions(db, user.id);
    expect(await getSessionUser(db, b.token)).toBeNull();
  });
});
