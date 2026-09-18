/** `__Host-` pins the cookie to this exact host and requires HTTPS, so it is used in production. */
export function sessionCookieName(nodeEnv: string | undefined): string {
  return nodeEnv === 'production' ? '__Host-sa_session' : 'sa_session';
}
