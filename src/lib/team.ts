import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { auditLog, users, type User } from '@/db/schema';
import { deleteUserSessions } from '@/lib/auth/sessions';
import { normalizeEmail } from '@/lib/auth/login';
import { assertCan, type Actor } from './permissions';
import { ROLES, type Role } from './roles';

const name = z.string().trim().min(1, 'Enter a name.').max(80, 'Keep it under 80 characters.');
const locationLabel = z
  .string()
  .trim()
  .max(80, 'Keep it under 80 characters.')
  .transform((v) => v || null);

export const inviteSchema = z.object({
  name,
  email: z
    .string()
    .trim()
    .max(254, 'That email is too long.')
    .pipe(z.email('Enter a valid email address.')),
  locationLabel,
  role: z.enum(ROLES, { error: 'Choose a role.' }),
});
export const profileSchema = z.object({ name, locationLabel });

export type FieldErrors = Record<string, string>;
export type TeamResult<T = undefined> =
  { ok: true; value: T } | { ok: false; error?: string; fieldErrors?: FieldErrors };

function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) out[String(issue.path[0])] ??= issue.message;
  return out;
}

const LAST_ADMIN = 'There must always be at least one active admin.';
const NOT_FOUND = 'That person is no longer on the team.';

export type TeamMember = Pick<
  User,
  'id' | 'name' | 'email' | 'role' | 'locationLabel' | 'disabledAt' | 'lastSignInAt' | 'createdAt'
>;

export async function listTeam(db: Db, actor: Actor): Promise<TeamMember[]> {
  assertCan(actor.role, 'team.manage');
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      locationLabel: users.locationLabel,
      disabledAt: users.disabledAt,
      lastSignInAt: users.lastSignInAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(sql`lower(${users.name})`));
}

/** Adds a person. Sending their sign-in email is a separate step (see sendInvite). */
export async function inviteUser(db: Db, actor: Actor, input: unknown): Promise<TeamResult<User>> {
  assertCan(actor.role, 'team.manage');
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error) };
  const { name, email, locationLabel, role } = parsed.data;
  const normalized = normalizeEmail(email);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, normalized));
    if (existing) {
      return {
        ok: false as const,
        fieldErrors: { email: 'Someone with that email is already on the team.' },
      };
    }
    const [user] = await tx
      .insert(users)
      .values({ name, email: normalized, role, locationLabel, invitedBy: actor.id })
      .returning();
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'user.invite',
      entity: 'user',
      entityId: user.id,
      diff: { email: normalized, role },
    });
    return { ok: true as const, value: user };
  });
}

/** Locks the active admins for the rest of the transaction and says whether `userId` is the only one. */
async function isLastActiveAdmin(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  userId: string,
): Promise<boolean> {
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
    .for('update');
  return admins.length === 1 && admins[0].id === userId;
}

export async function changeRole(
  db: Db,
  actor: Actor,
  userId: string,
  role: Role,
): Promise<TeamResult> {
  assertCan(actor.role, 'team.manage');
  if (!ROLES.includes(role)) return { ok: false, error: 'Choose a role.' };

  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!target) return { ok: false as const, error: NOT_FOUND };
    if (target.role === role) return { ok: true as const, value: undefined };
    if (target.role === 'admin' && !target.disabledAt && (await isLastActiveAdmin(tx, userId))) {
      return { ok: false as const, error: LAST_ADMIN };
    }
    await tx.update(users).set({ role }).where(eq(users.id, userId));
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'user.role_change',
      entity: 'user',
      entityId: userId,
      diff: { role: { from: target.role, to: role } },
    });
    return { ok: true as const, value: undefined };
  });
}

/** Disabling is how someone is removed: their sermons and history stay, and their sessions end now. */
export async function setUserDisabled(
  db: Db,
  actor: Actor,
  userId: string,
  disabled: boolean,
): Promise<TeamResult> {
  assertCan(actor.role, 'team.manage');

  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!target) return { ok: false as const, error: NOT_FOUND };
    if (Boolean(target.disabledAt) === disabled) return { ok: true as const, value: undefined };
    if (disabled && target.role === 'admin' && (await isLastActiveAdmin(tx, userId))) {
      return { ok: false as const, error: LAST_ADMIN };
    }
    await tx
      .update(users)
      .set({ disabledAt: disabled ? new Date() : null })
      .where(eq(users.id, userId));
    if (disabled) await deleteUserSessions(tx, userId);
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: disabled ? 'user.disable' : 'user.enable',
      entity: 'user',
      entityId: userId,
    });
    return { ok: true as const, value: undefined };
  });
}

/** Anyone can edit their own name and location. Email and role are admin-only. */
export async function updateOwnProfile(
  db: Db,
  actor: { id: string },
  input: unknown,
): Promise<TeamResult> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error) };
  await db
    .update(users)
    .set({ name: parsed.data.name, locationLabel: parsed.data.locationLabel })
    .where(eq(users.id, actor.id));
  return { ok: true, value: undefined };
}
