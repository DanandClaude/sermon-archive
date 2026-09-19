import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson, secretsKey, signState, verifyState } from './secrets';

const key = randomBytes(32);

describe('encryptJson and decryptJson', () => {
  it('round-trips a value', () => {
    const value = { refreshToken: 'abc/123+xyz', nested: { n: 1 } };
    expect(decryptJson(encryptJson(value, key), key)).toEqual(value);
  });

  it('does not put the secret in the stored text, and differs each time', () => {
    const a = encryptJson({ token: 'super-secret-token' }, key);
    const b = encryptJson({ token: 'super-secret-token' }, key);
    expect(a).not.toContain('super-secret-token');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
  });

  it('refuses the wrong key, and anything that was changed', () => {
    const token = encryptJson({ a: 1 }, key);
    expect(() => decryptJson(token, randomBytes(32))).toThrow();
    const parts = token.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptJson(parts.join('.'), key)).toThrow();
    expect(() => decryptJson('garbage', key)).toThrow(/Unrecognised/);
  });
});

describe('secretsKey', () => {
  it('uses the configured key', () => {
    expect(secretsKey('ab'.repeat(32), true)).toEqual(Buffer.from('ab'.repeat(32), 'hex'));
  });
  it('falls back to a fixed development key, but never in production', () => {
    expect(secretsKey(undefined, false)).toHaveLength(32);
    expect(secretsKey(undefined, false)).toEqual(secretsKey(undefined, false));
    expect(() => secretsKey(undefined, true)).toThrow(/required in production/);
  });
});

describe('signState and verifyState', () => {
  it('round-trips within its lifetime', () => {
    const token = signState({ role: 'shared', userId: 'u1' }, 600, key, 1_000_000);
    expect(verifyState(token, key, 1_000_000 + 599_000)).toMatchObject({
      role: 'shared',
      userId: 'u1',
    });
  });
  it('expires', () => {
    const token = signState({ role: 'shared' }, 600, key, 1_000_000);
    expect(verifyState(token, key, 1_000_000 + 601_000)).toBeNull();
  });
  it('rejects a changed payload, another key and junk', () => {
    const token = signState({ role: 'shared' }, 600, key);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ role: 'backup', exp: 9_999_999_999 })).toString(
      'base64url',
    );
    expect(verifyState(`${forged}.${mac}`, key)).toBeNull();
    expect(verifyState(`${body}.${mac}`, randomBytes(32))).toBeNull();
    expect(verifyState('nonsense', key)).toBeNull();
    expect(verifyState('', key)).toBeNull();
  });
});

describe('values written for the Python worker', () => {
  it('still decrypts the shared cases', async () => {
    const { readFileSync } = await import('node:fs');
    const cases = JSON.parse(readFileSync('shared/secrets-cases.json', 'utf8')) as {
      keyHex: string;
      cases: { token: string; plain: unknown }[];
    };
    for (const c of cases.cases) {
      expect(decryptJson(c.token, Buffer.from(cases.keyHex, 'hex'))).toEqual(c.plain);
    }
  });
});
