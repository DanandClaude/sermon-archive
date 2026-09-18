import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getDb } from '@/db/client';
import { sessionCookieName } from './cookie';
import { getSessionUser } from './sessions';
import type { SessionUser } from './types';

export type { SessionUser } from './types';

/** The signed-in user, or null. Reading the cookie also makes the page render per request. */
export const getOptionalUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(sessionCookieName(process.env.NODE_ENV))?.value;
  return token ? getSessionUser(getDb(), token) : null;
});

/** The signed-in user, or a redirect to sign in. */
export const getCurrentUser = cache(async (): Promise<SessionUser> => {
  const user = await getOptionalUser();
  if (!user) redirect('/sign-in');
  return user;
});
