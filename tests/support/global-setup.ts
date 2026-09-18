import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { testDatabaseUrl } from './test-db';

/** Rebuilds the test database from the checked-in migrations, so a bad migration fails the run. */
export default async function setup() {
  const url = testDatabaseUrl();
  const dbName = new URL(url).pathname.slice(1);
  // Guard: this drops every table, so never point it at a real database.
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to reset "${dbName}": test database names must end in _test.`);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`drop schema if exists public cascade`;
    await sql`drop schema if exists drizzle cascade`;
    await sql`create schema public`;
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  } finally {
    await sql.end();
  }
}
