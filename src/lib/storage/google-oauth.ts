import type { Db } from '@/db/client';
import { assertCan, type Actor } from '@/lib/permissions';
import { signState, verifyState } from '@/lib/secrets';
import { connectGoogleDrive, isRole, StorageError, type StorageRole } from './connections';

/**
 * `drive.file` lets the app see only the files and folders it creates itself. That is all filing
 * needs, it works without Google Workspace, and it cannot reach anything else in the account.
 * `openid email` only identifies which account was connected.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
] as const;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_TTL_SEC = 10 * 60;

export type GoogleClient = { clientId: string; clientSecret: string; redirectUri: string };

/** Where an admin is sent to sign in to Google. The state proves the round trip is ours. */
export function googleAuthUrl(client: GoogleClient, role: StorageRole, actor: Actor): string {
  const state = signState({ role, userId: actor.id }, STATE_TTL_SEC);
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // Offline access with a fresh consent, so Google always returns a refresh token.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

type Fetch = typeof fetch;

/** Reads the account email from the ID token Google returned over TLS in the same response. */
export function emailFromIdToken(idToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' && payload.email_verified !== false
      ? payload.email
      : null;
  } catch {
    return null;
  }
}

export type CallbackResult = { ok: true; role: StorageRole } | { ok: false; error: string };

/**
 * Finishes connecting: checks the state belongs to this admin, trades the code for a refresh
 * token, and saves it encrypted. Never throws for a bad or replayed link; says what went wrong.
 */
export async function completeGoogleConnection(
  db: Db,
  actor: Actor,
  input: { code: string | null; state: string | null; googleError?: string | null },
  client: GoogleClient,
  fetchImpl: Fetch = fetch,
): Promise<CallbackResult> {
  assertCan(actor.role, 'connections.manage');
  if (input.googleError) return { ok: false, error: 'Google did not connect the account.' };
  const state = input.state ? verifyState<{ role: string; userId: string }>(input.state) : null;
  if (!state || state.userId !== actor.id || !isRole(state.role) || !input.code) {
    return { ok: false, error: 'That sign-in link has expired. Start again.' };
  }
  let tokens: { refresh_token?: string; id_token?: string };
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) return { ok: false, error: 'Google would not complete the sign-in.' };
    tokens = (await response.json()) as typeof tokens;
  } catch {
    return { ok: false, error: 'Could not reach Google. Try again.' };
  }
  const email = tokens.id_token ? emailFromIdToken(tokens.id_token) : null;
  if (!tokens.refresh_token || !email) {
    return { ok: false, error: 'Google did not return a lasting sign-in. Try again.' };
  }
  try {
    await connectGoogleDrive(db, actor, state.role, { refreshToken: tokens.refresh_token, email });
  } catch (error) {
    if (error instanceof StorageError) return { ok: false, error: error.message };
    throw error;
  }
  return { ok: true, role: state.role };
}
