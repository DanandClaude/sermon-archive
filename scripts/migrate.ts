/**
 * Applies the database migrations. The Docker image runs this before the app starts, so a church
 * never has to run a migration by hand. Safe to run every time: applied migrations are skipped.
 *
 *   DATABASE_URL=postgres://... node dist/migrate.mjs
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: process.env.MIGRATIONS_DIR ?? './drizzle' });
    console.log('Database is up to date.');
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
