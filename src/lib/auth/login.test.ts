import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeMailer } from '@/adapters/mail/fake';
import { loginTokens, users } from '@/db/schema';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import {
  consumeLoginToken,
  INVITE_TOKEN_TTL_MS,
  issueLoginToken,
  LOGIN_TOKEN_TTL_MS,
  MAX_LINKS_PER_HOUR,
  requestSignIn,
  sendInvite,
} from './login';
import { hashToken } from './tokens';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

const base = { appUrl: 'https://archive.example.test', churchName: 'Grace Fellowship' };
const tokenFrom = (mail: string) =>
  new URL(mail.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

describe('requestSignIn', () => {
  it('emails a one-time link to an active user', async () => {
    const user = await insertUser(db, 'contributor', { email: 'Marcy@Example.test' });
    const mailer = new FakeMailer();
    expect(await requestSignIn(db, mailer, { ...base, email: ' marcy@example.TEST ' })).toBe(
      'sent',
    );
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0].to).toBe(user.email);
    expect(mailer.outbox[0].text).toContain('https://archive.example.test/sign-in/verify?token=');
    expect(mailer.outbox[0].subject).toContain('Grace Fellowship');
  });

  it('stores only a hash of the token', async () => {
    await insertUser(db, 'viewer', { email: 'a@example.test' });
    const mailer = new FakeMailer();
    await requestSignIn(db, mailer, { ...base, email: 'a@example.test' });
    const token = tokenFrom(mailer.outbox[0].text);
    const [row] = await db.select().from(loginTokens);
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).not.toContain(token);
  });

  it('does nothing, and sends nothing, for an address that is not on the team', async () => {
    const mailer = new FakeMailer();
    expect(await requestSignIn(db, mailer, { ...base, email: 'stranger@example.test' })).toBe(
      'unknown_or_disabled',
    );
    expect(mailer.outbox).toHaveLength(0);
    expect(await db.select().from(loginTokens)).toHaveLength(0);
  });

  it('does nothing for a disabled user', async () => {
    await insertUser(db, 'contributor', { email: 'gone@example.test', disabledAt: new Date() });
    const mailer = new FakeMailer();
    expect(await requestSignIn(db, mailer, { ...base, email: 'gone@example.test' })).toBe(
      'unknown_or_disabled',
    );
    expect(mailer.outbox).toHaveLength(0);
  });

  it(`stops after ${MAX_LINKS_PER_HOUR} links in an hour`, async () => {
    await insertUser(db, 'viewer', { email: 'busy@example.test' });
    const mailer = new FakeMailer();
    const now = new Date('2026-01-01T12:00:00Z');
    for (let i = 0; i < MAX_LINKS_PER_HOUR; i++) {
      expect(await requestSignIn(db, mailer, { ...base, email: 'busy@example.test', now })).toBe(
        'sent',
      );
    }
    expect(await requestSignIn(db, mailer, { ...base, email: 'busy@example.test', now })).toBe(
      'throttled',
    );
    expect(mailer.outbox).toHaveLength(MAX_LINKS_PER_HOUR);
    const later = new Date(now.getTime() + 61 * 60 * 1000);
    expect(
      await requestSignIn(db, mailer, { ...base, email: 'busy@example.test', now: later }),
    ).toBe('sent');
  });

  it('reports a mail failure without throwing or leaking it to the caller', async () => {
    await insertUser(db, 'viewer', { email: 'a@example.test' });
    const failing = { send: async () => Promise.reject(new Error('smtp down')) };
    expect(await requestSignIn(db, failing, { ...base, email: 'a@example.test' })).toBe(
      'mail_failed',
    );
  });
});

describe('sendInvite', () => {
  it('emails a link that lasts 7 days and names the inviter and role', async () => {
    const user = await insertUser(db, 'contributor', { name: 'Marcy T.' });
    const mailer = new FakeMailer();
    const now = new Date('2026-01-01T12:00:00Z');
    await sendInvite(db, mailer, { userId: user.id, inviterName: 'Pastor Lee', ...base, now });
    expect(mailer.outbox[0].subject).toContain('Pastor Lee added you');
    expect(mailer.outbox[0].text).toContain('as a contributor');
    const [row] = await db.select().from(loginTokens);
    expect(row.expiresAt.getTime() - now.getTime()).toBe(INVITE_TOKEN_TTL_MS);
  });

  it('refuses to invite a disabled user', async () => {
    const user = await insertUser(db, 'viewer', { disabledAt: new Date() });
    await expect(
      sendInvite(db, new FakeMailer(), { userId: user.id, inviterName: 'A', ...base }),
    ).rejects.toThrow(/disabled/);
  });
});

describe('consumeLoginToken', () => {
  const now = new Date('2026-01-01T12:00:00Z');

  it('returns the user id once, then never again', async () => {
    const user = await insertUser(db, 'contributor');
    const token = await issueLoginToken(db, user.id, LOGIN_TOKEN_TTL_MS, now);
    expect(await consumeLoginToken(db, token, now)).toBe(user.id);
    expect(await consumeLoginToken(db, token, now)).toBeNull();
  });

  it('lets exactly one of several simultaneous attempts win', async () => {
    const user = await insertUser(db, 'contributor');
    const token = await issueLoginToken(db, user.id, LOGIN_TOKEN_TTL_MS, now);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeLoginToken(db, token, now)),
    );
    expect(results.filter((r) => r === user.id)).toHaveLength(1);
  });

  it('rejects an expired token', async () => {
    const user = await insertUser(db, 'contributor');
    const token = await issueLoginToken(db, user.id, LOGIN_TOKEN_TTL_MS, now);
    const later = new Date(now.getTime() + LOGIN_TOKEN_TTL_MS + 1);
    expect(await consumeLoginToken(db, token, later)).toBeNull();
  });

  it('rejects a made-up token', async () => {
    await insertUser(db, 'contributor');
    expect(await consumeLoginToken(db, 'not-a-real-token', now)).toBeNull();
  });

  it('rejects a token whose user was disabled after it was issued', async () => {
    const user = await insertUser(db, 'contributor');
    const token = await issueLoginToken(db, user.id, LOGIN_TOKEN_TTL_MS, now);
    await db.update(users).set({ disabledAt: now }).where(eq(users.id, user.id));
    expect(await consumeLoginToken(db, token, now)).toBeNull();
  });

  it('records the sign-in and burns the person’s other outstanding links', async () => {
    const user = await insertUser(db, 'contributor');
    const first = await issueLoginToken(db, user.id, LOGIN_TOKEN_TTL_MS, now);
    const second = await issueLoginToken(db, user.id, LOGIN_TOKEN_TTL_MS, now);
    await consumeLoginToken(db, first, now);
    expect(await consumeLoginToken(db, second, now)).toBeNull();
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.lastSignInAt).toEqual(now);
  });
});
