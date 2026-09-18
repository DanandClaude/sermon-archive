/** Defaults to local Homebrew Postgres; CI sets TEST_DATABASE_URL. */
export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/sermon_archive_test';
}
