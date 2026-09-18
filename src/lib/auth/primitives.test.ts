import { describe, expect, it } from 'vitest';
import { sessionCookieName } from './cookie';
import { DEFAULT_LANDING, safeNextPath } from './redirect';
import { generateToken, hashToken } from './tokens';

describe('tokens', () => {
  it('generates long, unique, URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically to 64 hex characters', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('safeNextPath', () => {
  it.each(['/library', '/admin/team', '/upload?x=1'])('keeps the same-site path %s', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    null,
    undefined,
    '',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'library',
    'javascript:alert(1)',
    '/sign-in',
    '/sign-in/verify?token=x',
  ])('falls back to the library for %j', (next) => {
    expect(safeNextPath(next)).toBe(DEFAULT_LANDING);
  });
});

describe('sessionCookieName', () => {
  it('uses the __Host- prefix only in production', () => {
    expect(sessionCookieName('production')).toBe('__Host-sa_session');
    expect(sessionCookieName('development')).toBe('sa_session');
    expect(sessionCookieName(undefined)).toBe('sa_session');
  });
});
