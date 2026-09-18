'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getMailer } from '@/adapters';
import { getDb } from '@/db/client';
import { getEnv } from '@/lib/env';
import { RateLimiter } from '@/lib/rate-limit';
import { getSettings } from '@/lib/settings';
import { sessionCookieName } from './cookie';
import { consumeLoginToken, requestSignIn } from './login';
import { safeNextPath } from './redirect';
import { createSession, deleteSession } from './sessions';

export type SignInState = { status: 'idle' | 'sent' | 'error'; email: string; error?: string };

// Per process; fine for one deployment. Stops one address hammering the form.
const requestLimiter = new RateLimiter(10, 10 * 60 * 1000);

export async function requestLink(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get('email') ?? '').trim();
  const next = String(formData.get('next') ?? '');
  if (!z.email().max(254).safeParse(email).success) {
    return { status: 'error', email, error: 'Enter a valid email address.' };
  }
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!requestLimiter.allow(ip)) {
    return { status: 'error', email, error: 'Too many tries. Wait a few minutes and try again.' };
  }
  const db = getDb();
  const { churchName } = await getSettings(db);
  // Same answer whether or not the address is on the team.
  await requestSignIn(db, getMailer(), { email, appUrl: getEnv().APP_URL, churchName, next });
  return { status: 'sent', email };
}

/** Runs only from the button on the confirm page, so email scanners that open links can't spend them. */
export async function confirmSignIn(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const next = safeNextPath(String(formData.get('next') ?? ''));
  const db = getDb();
  const userId = token ? await consumeLoginToken(db, token) : null;
  if (!userId) redirect('/sign-in?expired=1');

  const userAgent = (await headers()).get('user-agent');
  const { token: sessionToken, expiresAt } = await createSession(db, userId, { userAgent });
  (await cookies()).set(sessionCookieName(process.env.NODE_ENV), sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  redirect(next);
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  const name = sessionCookieName(process.env.NODE_ENV);
  const token = store.get(name)?.value;
  if (token) await deleteSession(getDb(), token);
  store.delete(name);
  redirect('/sign-in');
}
