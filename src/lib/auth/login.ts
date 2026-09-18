import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Mailer } from '@/adapters/mail/types';
import type { Db } from '@/db/client';
import { loginTokens, users, type User } from '@/db/schema';
import { ROLE_LABELS } from '@/lib/roles';
import { DEFAULT_LANDING, safeNextPath } from './redirect';
import { generateToken, hashToken } from './tokens';

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Invite emails may be read a day later; anyone can also just request a fresh link. */
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LINKS_PER_HOUR = 5;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function signInUrl(appUrl: string, token: string, next?: string): string {
  const url = `${appUrl}/sign-in/verify?token=${encodeURIComponent(token)}`;
  const safe = safeNextPath(next);
  return safe === DEFAULT_LANDING ? url : `${url}&next=${encodeURIComponent(safe)}`;
}

export async function findActiveUserByEmail(db: Db, email: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(sql`lower(${users.email})`, normalizeEmail(email)), isNull(users.disabledAt)));
  return user;
}

/** Returns the raw token. Only its hash is stored. */
export async function issueLoginToken(
  db: Db,
  userId: string,
  ttlMs: number,
  now = new Date(),
): Promise<string> {
  const token = generateToken();
  await db.insert(loginTokens).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + ttlMs),
    createdAt: now,
  });
  return token;
}

export type RequestSignInResult = 'sent' | 'unknown_or_disabled' | 'throttled' | 'mail_failed';

/**
 * Sends a sign-in link if the address belongs to an active user. Callers must show the same
 * message for every outcome so the form can't be used to find out who is on the team.
 */
export async function requestSignIn(
  db: Db,
  mailer: Mailer,
  input: { email: string; appUrl: string; churchName: string; next?: string; now?: Date },
): Promise<RequestSignInResult> {
  const now = input.now ?? new Date();
  const user = await findActiveUserByEmail(db, input.email);
  if (!user) return 'unknown_or_disabled';

  const [{ recent }] = await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.userId, user.id),
        gt(loginTokens.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
      ),
    );
  if (recent >= MAX_LINKS_PER_HOUR) return 'throttled';

  const token = await issueLoginToken(db, user.id, LOGIN_TOKEN_TTL_MS, now);
  try {
    await mailer.send({
      to: user.email,
      subject: `Your sign-in link for the ${input.churchName} Sermon Archive`,
      text: [
        `Hi ${user.name},`,
        '',
        `Use this link to sign in to the ${input.churchName} Sermon Archive. It works once and expires in 15 minutes.`,
        '',
        signInUrl(input.appUrl, token, input.next),
        '',
        "If you didn't ask for this, you can ignore this email.",
      ].join('\n'),
    });
  } catch (error) {
    console.error('Could not send sign-in email', error);
    return 'mail_failed';
  }
  return 'sent';
}

/** Emails a newly added person their first sign-in link. Throws if the email can't be sent. */
export async function sendInvite(
  db: Db,
  mailer: Mailer,
  input: { userId: string; inviterName: string; appUrl: string; churchName: string; now?: Date },
): Promise<void> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, input.userId), isNull(users.disabledAt)));
  if (!user) throw new Error('Cannot invite a missing or disabled user.');
  const token = await issueLoginToken(db, user.id, INVITE_TOKEN_TTL_MS, input.now);
  await mailer.send({
    to: user.email,
    subject: `${input.inviterName} added you to the ${input.churchName} Sermon Archive`,
    text: [
      `Hi ${user.name},`,
      '',
      `${input.inviterName} added you to the ${input.churchName} Sermon Archive as a ${ROLE_LABELS[user.role].toLowerCase()}.`,
      '',
      'Use this link to sign in for the first time. It works once and expires in 7 days:',
      '',
      signInUrl(input.appUrl, token),
      '',
      `After that, go to ${input.appUrl}/sign-in and enter this email address whenever you need a new link.`,
    ].join('\n'),
  });
}

/**
 * Atomically spends a token. Returns the user id, or null if the token is unknown, already
 * used, expired, or belongs to a user who has since been disabled.
 */
export async function consumeLoginToken(
  db: Db,
  token: string,
  now = new Date(),
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [spent] = await tx
      .update(loginTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(loginTokens.tokenHash, hashToken(token)),
          isNull(loginTokens.usedAt),
          gt(loginTokens.expiresAt, now),
        ),
      )
      .returning({ userId: loginTokens.userId });
    if (!spent) return null;

    const [user] = await tx.select().from(users).where(eq(users.id, spent.userId));
    if (!user || user.disabledAt) return null;

    await tx.update(users).set({ lastSignInAt: now }).where(eq(users.id, user.id));
    // Signing in makes any other outstanding links for this person useless.
    await tx
      .update(loginTokens)
      .set({ usedAt: now })
      .where(and(eq(loginTokens.userId, user.id), isNull(loginTokens.usedAt)));
    return user.id;
  });
}
