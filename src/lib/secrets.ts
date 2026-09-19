import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Encrypts small secrets (a Google refresh token, a folder path) so the database alone is not
 * enough to use them. AES-256-GCM, one random IV each. The Python worker reads the same format
 * (`worker/src/sermon_worker/secrets_box.py`); `shared/secrets-cases.json` keeps them in step.
 *
 *   v1.<iv>.<tag>.<ciphertext>      (base64url parts)
 */
const DEV_KEY_SEED = 'sermon-archive-development-only-secrets-key';

export function secretsKey(hex: string | undefined, production: boolean): Buffer {
  if (hex) return Buffer.from(hex, 'hex');
  if (production) throw new Error('SECRETS_KEY is required in production.');
  // Development and tests only. Anyone with the code knows this key.
  return createHash('sha256').update(DEV_KEY_SEED).digest();
}

/** Read straight from the environment, so this works without the rest of the app's settings. */
function currentKey(): Buffer {
  const hex = process.env.SECRETS_KEY?.trim() || undefined;
  if (hex && !/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error('SECRETS_KEY must be 64 hex characters (openssl rand -hex 32).');
  return secretsKey(hex, process.env.NODE_ENV === 'production');
}

export function encryptJson(value: unknown, key: Buffer = currentKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptJson<T = unknown>(token: string, key: Buffer = currentKey()): T {
  const [version, iv, tag, body] = token.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unrecognised encrypted value.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}

/** A tamper-proof, expiring token for the OAuth round trip. Not encrypted: it holds nothing secret. */
export function signState(
  payload: Record<string, unknown>,
  ttlSec: number,
  key: Buffer = currentKey(),
  now = Date.now(),
): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSec }),
  ).toString('base64url');
  return `${body}.${stateMac(body, key)}`;
}

export function verifyState<T extends Record<string, unknown>>(
  token: string,
  key: Buffer = currentKey(),
  now = Date.now(),
): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(stateMac(body, key));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & {
      exp?: number;
    };
    return typeof payload.exp === 'number' && payload.exp * 1000 >= now ? payload : null;
  } catch {
    return null;
  }
}

const stateMac = (body: string, key: Buffer) =>
  createHmac('sha256', key).update(`oauth-state.${body}`).digest('base64url');
