import { describe, expect, it } from 'vitest';
import { isSameOrigin } from './origin';

const req = (
  headers: Record<string, string>,
  url = 'https://archive.example.test/api/uploads',
) => ({
  headers: new Headers(headers),
  url,
});

describe('isSameOrigin', () => {
  it('allows a request from the same site', () => {
    expect(
      isSameOrigin(req({ origin: 'https://archive.example.test', host: 'archive.example.test' })),
    ).toBe(true);
  });

  it('allows requests with no Origin header (not a browser cross-site request)', () => {
    expect(isSameOrigin(req({ host: 'archive.example.test' }))).toBe(true);
  });

  it('refuses a request from another site', () => {
    expect(
      isSameOrigin(req({ origin: 'https://evil.example', host: 'archive.example.test' })),
    ).toBe(false);
  });

  it('refuses a look-alike host', () => {
    expect(
      isSameOrigin(
        req({ origin: 'https://archive.example.test.evil.example', host: 'archive.example.test' }),
      ),
    ).toBe(false);
  });

  it('refuses a malformed Origin', () => {
    expect(isSameOrigin(req({ origin: 'not a url', host: 'archive.example.test' }))).toBe(false);
  });

  it('trusts x-forwarded-host when the app sits behind a proxy', () => {
    expect(
      isSameOrigin(
        req({
          origin: 'https://archive.example.test',
          host: 'internal:3000',
          'x-forwarded-host': 'archive.example.test',
        }),
      ),
    ).toBe(true);
  });
});
