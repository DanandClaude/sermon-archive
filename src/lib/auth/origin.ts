/**
 * Defence in depth for state-changing API calls: browsers always send Origin on cross-site
 * requests, so a request from another site is refused even if a cookie somehow came along.
 * (Session cookies are also SameSite=Lax.) Requests with no Origin, such as curl, are allowed
 * because they can't carry a victim's cookie.
 */
export function isSameOrigin(request: { headers: Headers; url: string }): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    new URL(request.url).host;
  return originHost === host;
}
