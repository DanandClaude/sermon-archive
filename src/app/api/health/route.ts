import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * For Docker health checks and uptime monitors. No sign-in needed, and it says nothing about the
 * deployment beyond whether the app can reach its database.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
