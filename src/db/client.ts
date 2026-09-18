import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from '@/lib/env';
import * as schema from './schema';

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return Object.assign(drizzle(sql, { schema }), { close: () => sql.end() });
}

export type Db = ReturnType<typeof createDb>;

// Reuse one pool across dev hot reloads.
const globalForDb = globalThis as unknown as { __db?: Db };

export function getDb(): Db {
  globalForDb.__db ??= createDb(getEnv().DATABASE_URL);
  return globalForDb.__db;
}
