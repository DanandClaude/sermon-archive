/**
 * True when a database write failed because it would break a unique index (Postgres code 23505).
 * Drizzle wraps the driver's error, so the code can be on the error itself or on its `cause`.
 */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
