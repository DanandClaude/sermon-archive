import { NextResponse, type NextRequest } from 'next/server';
import { sessionCookieName } from '@/lib/auth/cookie';

/**
 * Optimistic redirect only: it sends people without a session cookie to sign in and remembers
 * where they were going. It does not prove the session is valid. Every page, action and API
 * route still checks the real session on the server.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has(sessionCookieName(process.env.NODE_ENV))) return NextResponse.next();
  const url = new URL('/sign-in', request.url);
  url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Pages only. API routes answer 401 themselves; sign-in and the dev outbox must work signed out.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|sign-in|dev/).*)'],
};
