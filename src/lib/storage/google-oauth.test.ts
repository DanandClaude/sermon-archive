import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, storageTargets } from '@/db/schema';
import { ForbiddenError } from '@/lib/errors';
import { decryptJson, signState } from '@/lib/secrets';
import { insertUser, openTestDb, resetTables } from '../../../tests/support/db';
import { connectGoogleDrive } from './connections';
import {
  completeGoogleConnection,
  emailFromIdToken,
  GOOGLE_SCOPES,
  googleAuthUrl,
} from './google-oauth';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

const client = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://a.test/cb' };
const idToken = (claims: object) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const tokenReply = (body: object, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);

describe('googleAuthUrl', () => {
  it('asks only for files the app makes, plus who signed in', async () => {
    const admin = await insertUser(db, 'admin');
    const url = new URL(googleAuthUrl(client, 'shared', admin));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_SCOPES.join(' '));
    expect(url.searchParams.get('scope')).not.toMatch(/auth\/drive(\s|$)/);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe('https://a.test/cb');
    expect(url.searchParams.get('client_secret')).toBeNull();
  });
});

describe('emailFromIdToken', () => {
  it('reads the verified email', () => {
    expect(emailFromIdToken(idToken({ email: 'a@b.org', email_verified: true }))).toBe('a@b.org');
  });
  it.each([
    ['unverified', idToken({ email: 'a@b.org', email_verified: false })],
    ['no email', idToken({ sub: '1' })],
    ['garbage', 'not-a-token'],
  ])('refuses %s', (_name, token) => expect(emailFromIdToken(token)).toBeNull());
});

describe('completeGoogleConnection', () => {
  const start = async () => {
    const admin = await insertUser(db, 'admin');
    const state = new URL(googleAuthUrl(client, 'backup', admin)).searchParams.get('state')!;
    return { admin, state };
  };

  it('saves the refresh token encrypted against the right target', async () => {
    const { admin, state } = await start();
    const fetchImpl = tokenReply({
      refresh_token: 'rt-123',
      id_token: idToken({ email: 'vault@example.org' }),
    });
    const result = await completeGoogleConnection(
      db,
      admin,
      { code: 'abc', state },
      client,
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, role: 'backup' });
    const [row] = await db.select().from(storageTargets);
    expect([row.role, row.accountLabel]).toEqual(['backup', 'vault@example.org']);
    expect(decryptJson(row.encryptedConfig!)).toMatchObject({ refreshToken: 'rt-123' });
    const [call] = fetchImpl.mock.calls as unknown as [string, { body: URLSearchParams }][];
    expect(call[1].body.get('code')).toBe('abc');
    expect(call[1].body.get('grant_type')).toBe('authorization_code');
  });

  it('never puts the token in the audit log', async () => {
    const { admin, state } = await start();
    await completeGoogleConnection(
      db,
      admin,
      { code: 'abc', state },
      client,
      tokenReply({ refresh_token: 'rt-secret', id_token: idToken({ email: 'v@example.org' }) }),
    );
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain('rt-secret');
  });

  it("refuses another admin's link, an expired one, a forged one and a missing code", async () => {
    const { admin, state } = await start();
    const other = await insertUser(db, 'admin');
    const fetchImpl = tokenReply({});
    const attempts = [
      completeGoogleConnection(db, other, { code: 'c', state }, client, fetchImpl),
      completeGoogleConnection(
        db,
        admin,
        { code: 'c', state: signState({ role: 'backup', userId: admin.id }, -5) },
        client,
        fetchImpl,
      ),
      completeGoogleConnection(
        db,
        admin,
        { code: 'c', state: signState({ role: 'root', userId: admin.id }, 600) },
        client,
        fetchImpl,
      ),
      completeGoogleConnection(db, admin, { code: 'c', state: state + 'x' }, client, fetchImpl),
      completeGoogleConnection(db, admin, { code: null, state }, client, fetchImpl),
      completeGoogleConnection(db, admin, { code: 'c', state: null }, client, fetchImpl),
    ];
    for (const result of await Promise.all(attempts)) expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await db.select().from(storageTargets)).toHaveLength(0);
  });

  it('reports what went wrong when Google declines, sends no refresh token, or is unreachable', async () => {
    const { admin, state } = await start();
    const declined = await completeGoogleConnection(
      db,
      admin,
      { code: 'c', state },
      client,
      tokenReply({}, false),
    );
    const noToken = await completeGoogleConnection(
      db,
      admin,
      { code: 'c', state },
      client,
      tokenReply({ id_token: idToken({ email: 'a@b.org' }) }),
    );
    const offline = await completeGoogleConnection(
      db,
      admin,
      { code: 'c', state },
      client,
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    const denied = await completeGoogleConnection(
      db,
      admin,
      { code: null, state, googleError: 'access_denied' },
      client,
    );
    for (const r of [declined, noToken, offline, denied]) expect(r.ok).toBe(false);
    expect(await db.select().from(storageTargets)).toHaveLength(0);
  });

  it('passes on the message when the account is already used by the other target', async () => {
    const { admin, state } = await start();
    await connectGoogleDrive(db, admin, 'shared', { refreshToken: 'r', email: 'same@example.org' });
    const result = await completeGoogleConnection(
      db,
      admin,
      { code: 'c', state },
      client,
      tokenReply({ refresh_token: 'r2', id_token: idToken({ email: 'SAME@example.org' }) }),
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('different account');
  });

  it('is for admins only', async () => {
    const contributor = await insertUser(db, 'contributor');
    await expect(
      completeGoogleConnection(db, contributor, { code: 'c', state: 's' }, client, tokenReply({})),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
