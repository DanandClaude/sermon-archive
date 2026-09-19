import { resolveAdapterMode } from '@/adapters/mode';
import { getEnv } from '@/lib/env';
import type { GoogleClient } from './google-oauth';

/**
 * The OAuth client for connecting Google Drive, or null when this deployment must not talk to
 * Google (development and tests use a folder on this machine instead).
 */
export function getGoogleClient(): GoogleClient | null {
  const env = getEnv();
  if (resolveAdapterMode(env) !== 'real') return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
    redirectUri: `${env.APP_URL}/api/connections/google/callback`,
  };
}

export const isRealMode = () => resolveAdapterMode(getEnv()) === 'real';
