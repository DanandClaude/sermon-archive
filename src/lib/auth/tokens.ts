import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of randomness, safe to put in a URL or cookie. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored, so a database leak does not hand out working links or sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
