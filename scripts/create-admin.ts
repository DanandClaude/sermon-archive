/**
 * Creates the first admin (or re-issues a sign-in link for an existing admin) and prints a
 * one-time sign-in link. Run on the server:
 *   npm run admin:create -- --email you@example.org --name "Your Name"
 */
import { loadEnvConfig } from '@next/env';
import { eq, sql } from 'drizzle-orm';
import { parseArgs } from 'node:util';

loadEnvConfig(process.cwd());

async function main() {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, location: { type: 'string' } },
  });
  if (!values.email || !values.name) {
    console.error(
      'Usage: npm run admin:create -- --email <email> --name <name> [--location <place>]',
    );
    process.exit(1);
  }
  const { createDb } = await import('../src/db/client');
  const { auditLog, users } = await import('../src/db/schema');
  const { getEnv } = await import('../src/lib/env');
  const { INVITE_TOKEN_TTL_MS, issueLoginToken, normalizeEmail, signInUrl } =
    await import('../src/lib/auth/login');

  const env = getEnv();
  const db = createDb(env.DATABASE_URL);
  try {
    const email = normalizeEmail(values.email);
    let [user] = await db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.email})`, email));
    if (user && user.role !== 'admin') {
      console.error(
        `${email} already exists as a ${user.role}. Change their role in Team & access.`,
      );
      process.exit(1);
    }
    if (user?.disabledAt) {
      console.error(`${email} is disabled. Re-enable them in Team & access.`);
      process.exit(1);
    }
    if (!user) {
      [user] = await db
        .insert(users)
        .values({
          email,
          name: values.name.trim(),
          role: 'admin',
          locationLabel: values.location?.trim() || null,
        })
        .returning();
      await db.insert(auditLog).values({
        action: 'user.bootstrap_admin',
        entity: 'user',
        entityId: user.id,
        diff: { email, role: 'admin' },
      });
      console.log(`Created admin ${email}.`);
    }
    const token = await issueLoginToken(db, user.id, INVITE_TOKEN_TTL_MS);
    console.log(`\nOne-time sign-in link (valid 7 days):\n${signInUrl(env.APP_URL, token)}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
