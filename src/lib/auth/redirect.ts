export const DEFAULT_LANDING = '/library';

/** Only same-site paths are allowed after sign-in, so a crafted link can't send people elsewhere. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return DEFAULT_LANDING;
  }
  if (next.startsWith('/sign-in')) return DEFAULT_LANDING;
  return next;
}
