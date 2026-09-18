import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, sessions, users } from '@/db/schema';
import { createSession, getSessionUser } from '@/lib/auth/sessions';
import { insertUser, openTestDb, resetTables } from '../../tests/support/db';
import { ForbiddenError } from './errors';
import { changeRole, inviteUser, listTeam, setUserDisabled, updateOwnProfile } from './team';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

const valid = {
  name: 'Marcy T.',
  email: 'Marcy@Example.test',
  locationLabel: 'Tulsa, OK',
  role: 'contributor',
};
const roleOf = async (id: string) =>
  (await db.select().from(users).where(eq(users.id, id)))[0].role;

describe('permissions', () => {
  it.each(['contributor', 'viewer'] as const)('a %s cannot manage the team', async (role) => {
    const actor = await insertUser(db, role);
    const target = await insertUser(db, 'viewer');
    await expect(listTeam(db, actor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(inviteUser(db, actor, valid)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(changeRole(db, actor, target.id, 'admin')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserDisabled(db, actor, target.id, true)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await roleOf(target.id)).toBe('viewer');
  });
});

describe('inviteUser', () => {
  it('adds a person with a lower-cased email and records who invited them', async () => {
    const admin = await insertUser(db, 'admin');
    const result = await inviteUser(db, admin, valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      name: 'Marcy T.',
      email: 'marcy@example.test',
      role: 'contributor',
      locationLabel: 'Tulsa, OK',
      invitedBy: admin.id,
    });
    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({
      actorId: admin.id,
      action: 'user.invite',
      entityId: result.value.id,
    });
  });

  it('stores a blank location as null', async () => {
    const admin = await insertUser(db, 'admin');
    const result = await inviteUser(db, admin, { ...valid, locationLabel: '   ' });
    expect(result.ok && result.value.locationLabel).toBeNull();
  });

  it('refuses a duplicate email in any case', async () => {
    const admin = await insertUser(db, 'admin');
    await inviteUser(db, admin, valid);
    const again = await inviteUser(db, admin, { ...valid, email: 'MARCY@example.test' });
    expect(again).toEqual({
      ok: false,
      fieldErrors: { email: expect.stringMatching(/already on the team/) },
    });
  });

  it('reports each invalid field', async () => {
    const admin = await insertUser(db, 'admin');
    const result = await inviteUser(db, admin, {
      name: ' ',
      email: 'nope',
      locationLabel: '',
      role: 'boss',
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(Object.keys(result.fieldErrors ?? {}).sort()).toEqual(['email', 'name', 'role']);
    expect(await db.select().from(users)).toHaveLength(1);
  });
});

describe('changeRole', () => {
  it('changes a role and audits the old and new values', async () => {
    const admin = await insertUser(db, 'admin');
    const person = await insertUser(db, 'viewer');
    expect(await changeRole(db, admin, person.id, 'contributor')).toMatchObject({ ok: true });
    expect(await roleOf(person.id)).toBe('contributor');
    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({
      action: 'user.role_change',
      diff: { role: { from: 'viewer', to: 'contributor' } },
    });
  });

  it('does nothing, and writes no audit entry, when the role is unchanged', async () => {
    const admin = await insertUser(db, 'admin');
    const person = await insertUser(db, 'viewer');
    await changeRole(db, admin, person.id, 'viewer');
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('will not demote the last admin, even themselves', async () => {
    const admin = await insertUser(db, 'admin');
    expect(await changeRole(db, admin, admin.id, 'viewer')).toEqual({
      ok: false,
      error: expect.stringMatching(/at least one active admin/),
    });
    expect(await roleOf(admin.id)).toBe('admin');
  });

  it('allows demoting an admin while another active admin remains', async () => {
    const a = await insertUser(db, 'admin');
    const b = await insertUser(db, 'admin');
    expect(await changeRole(db, a, b.id, 'contributor')).toMatchObject({ ok: true });
  });

  it('does not count a disabled admin as the remaining one', async () => {
    const a = await insertUser(db, 'admin');
    await insertUser(db, 'admin', { disabledAt: new Date() });
    expect(await changeRole(db, a, a.id, 'viewer')).toMatchObject({ ok: false });
  });

  it('when two admins demote each other at once, exactly one succeeds', async () => {
    const a = await insertUser(db, 'admin');
    const b = await insertUser(db, 'admin');
    const [r1, r2] = await Promise.all([
      changeRole(db, a, b.id, 'viewer'),
      changeRole(db, b, a.id, 'viewer'),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const admins = (await db.select().from(users)).filter((u) => u.role === 'admin');
    expect(admins).toHaveLength(1);
  });

  it('reports a person who no longer exists', async () => {
    const admin = await insertUser(db, 'admin');
    const result = await changeRole(db, admin, crypto.randomUUID(), 'viewer');
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no longer on the team/),
    });
  });
});

describe('setUserDisabled', () => {
  it('disables a person, ends their sessions straight away, and audits it', async () => {
    const admin = await insertUser(db, 'admin');
    const person = await insertUser(db, 'contributor');
    const { token } = await createSession(db, person.id);
    expect(await setUserDisabled(db, admin, person.id, true)).toMatchObject({ ok: true });
    expect(await getSessionUser(db, token)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, person.id))).toHaveLength(0);
    expect((await db.select().from(auditLog))[0]).toMatchObject({
      action: 'user.disable',
      entityId: person.id,
    });
  });

  it('can re-enable a person', async () => {
    const admin = await insertUser(db, 'admin');
    const person = await insertUser(db, 'contributor', { disabledAt: new Date() });
    await setUserDisabled(db, admin, person.id, false);
    const [row] = await db.select().from(users).where(eq(users.id, person.id));
    expect(row.disabledAt).toBeNull();
  });

  it('will not disable the last active admin', async () => {
    const admin = await insertUser(db, 'admin');
    expect(await setUserDisabled(db, admin, admin.id, true)).toMatchObject({ ok: false });
    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row.disabledAt).toBeNull();
  });
});

describe('updateOwnProfile', () => {
  it('lets someone change their own name and location, and nothing else', async () => {
    const person = await insertUser(db, 'contributor');
    const result = await updateOwnProfile(db, person, {
      name: ' Marcy Tate ',
      locationLabel: 'Tulsa, OK',
      role: 'admin',
      email: 'hacker@example.test',
    });
    expect(result.ok).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, person.id));
    expect(row).toMatchObject({
      name: 'Marcy Tate',
      locationLabel: 'Tulsa, OK',
      role: 'contributor',
      email: person.email,
    });
  });

  it('rejects an empty name', async () => {
    const person = await insertUser(db, 'viewer');
    const result = await updateOwnProfile(db, person, { name: '', locationLabel: '' });
    expect(result).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String) } });
  });
});
