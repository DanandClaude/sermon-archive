import 'server-only';
import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { ForbiddenError } from '@/lib/errors';
import { can, type Capability } from '@/lib/permissions';
import { RateLimiter } from '@/lib/rate-limit';
import { UploadError } from '@/lib/uploads/service';
import { sessionCookieName } from './cookie';
import { isSameOrigin } from './origin';
import { getSessionUser } from './sessions';
import type { SessionUser } from './types';

export function jsonError(status: number, code: string, message: string, extra: object = {}) {
  return Response.json({ code, error: message, ...extra }, { status });
}

// Generous: a 40-file batch is a few hundred requests. This only bounds abuse.
const apiLimiter = new RateLimiter(1200, 60 * 1000);

/**
 * Authenticates an API request: signed in, allowed to do this, same origin for writes, and
 * not flooding. Route handlers must call this first; the proxy does not protect /api.
 */
export async function authenticateApi(
  request: Request,
  capability: Capability,
): Promise<{ user: SessionUser } | { response: Response }> {
  if (request.method !== 'GET' && !isSameOrigin(request)) {
    return { response: jsonError(403, 'forbidden', 'Cross-site request refused.') };
  }
  const token = (await cookies()).get(sessionCookieName(process.env.NODE_ENV))?.value;
  const user = token ? await getSessionUser(getDb(), token) : null;
  if (!user) return { response: jsonError(401, 'unauthenticated', 'Sign in to continue.') };
  if (!can(user.role, capability)) {
    return { response: jsonError(403, 'forbidden', 'You do not have permission to do that.') };
  }
  if (!apiLimiter.allow(user.id)) {
    return {
      response: jsonError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.'),
    };
  }
  return { user };
}

export async function readJson(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    return jsonError(400, 'invalid', 'The request body must be JSON.');
  }
}

/** Turns the upload service's errors into JSON responses. Anything unexpected is a 500. */
export function uploadErrorResponse(error: unknown): Response {
  if (error instanceof ForbiddenError) return jsonError(403, 'forbidden', error.message);
  if (error instanceof UploadError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'incomplete' ? 409 : 400;
    return jsonError(status, error.code, error.message, {
      fieldErrors: error.fieldErrors,
      missingParts: error.missingParts,
    });
  }
  console.error('Upload API error', error);
  return jsonError(500, 'server_error', 'Something went wrong. Try again.');
}
