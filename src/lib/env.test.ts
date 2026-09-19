import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

describe('parseEnv', () => {
  it('requires DATABASE_URL', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('defaults to development with fake adapters', () => {
    const env = parseEnv({ DATABASE_URL: 'postgres://localhost/x' });
    expect(env.NODE_ENV).toBe('development');
    expect(env.ADAPTER_MODE).toBe('fake');
  });

  it('rejects an unknown ADAPTER_MODE', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: 'postgres://localhost/x', ADAPTER_MODE: 'live' }),
    ).toThrow(/ADAPTER_MODE/);
  });

  it('defaults APP_URL to localhost outside production and strips a trailing slash', () => {
    expect(parseEnv({ DATABASE_URL: 'x' }).APP_URL).toBe('http://localhost:3000');
    expect(parseEnv({ DATABASE_URL: 'x', APP_URL: 'https://archive.example.test/' }).APP_URL).toBe(
      'https://archive.example.test',
    );
  });

  it('requires APP_URL in production so emailed links never come from a request header', () => {
    expect(() => parseEnv({ DATABASE_URL: 'x', NODE_ENV: 'production' })).toThrow(/APP_URL/);
  });

  it('rejects a malformed APP_URL', () => {
    expect(() => parseEnv({ DATABASE_URL: 'x', APP_URL: 'not a url' })).toThrow(/APP_URL/);
  });

  it('requires mail and storage settings in real mode', () => {
    const real = {
      DATABASE_URL: 'x',
      NODE_ENV: 'production',
      APP_URL: 'https://a.test',
      ADAPTER_MODE: 'real',
    };
    expect(() => parseEnv(real)).toThrow(
      /SMTP_URL[\s\S]*MAIL_FROM[\s\S]*S3_BUCKET[\s\S]*S3_REGION[\s\S]*GOOGLE_CLIENT_ID[\s\S]*GOOGLE_CLIENT_SECRET/,
    );
    expect(
      parseEnv({
        ...real,
        SMTP_URL: 'smtp://x',
        MAIL_FROM: 'a@a.test',
        S3_BUCKET: 'b',
        S3_REGION: 'us-east-1',
        SECRETS_KEY: 'ab'.repeat(32),
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
      }).S3_BUCKET,
    ).toBe('b');
  });

  it('requires a secrets key in production, and only a well-formed one anywhere', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: 'x', NODE_ENV: 'production', APP_URL: 'https://a.test' }),
    ).toThrow(/SECRETS_KEY/);
    expect(() => parseEnv({ DATABASE_URL: 'x', SECRETS_KEY: 'too-short' })).toThrow(/64 hex/);
    expect(parseEnv({ DATABASE_URL: 'x' }).SECRETS_KEY).toBeUndefined();
  });

  it('treats blank optional values as unset', () => {
    expect(parseEnv({ DATABASE_URL: 'x', SMTP_URL: '  ' }).SMTP_URL).toBeUndefined();
  });
});
