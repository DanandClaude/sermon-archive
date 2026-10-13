/**
 * Accessibility check: signs in as each role and runs axe (WCAG 2.1 A and AA) on every page that
 * role can open, in a real browser. Development only; run it against `npm run dev`:
 *   npm run a11y                     # uses APP_URL and the first active user of each role
 *   CHROMIUM_PATH=/path/to/chrome npm run a11y
 * Exits non-zero when any page has a violation.
 */
import { loadEnvConfig } from '@next/env';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser } from 'playwright-core';

loadEnvConfig(process.cwd());

type Role = 'admin' | 'contributor' | 'viewer';
type Finding = {
  role: Role;
  path: string;
  id: string;
  impact: string;
  help: string;
  nodes: string[];
};

const COMMON = ['/library', '/library?view=grid', '/profile', '/this-page-does-not-exist'];
const BY_ROLE: Record<Role, string[]> = {
  viewer: [],
  contributor: ['/upload', '/review'],
  admin: [
    '/upload',
    '/review',
    '/admin/connections',
    '/admin/publishing',
    '/admin/health',
    '/admin/team',
    '/admin/settings',
  ],
};

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.ADAPTER_MODE === 'real') {
    console.error('The accessibility check signs people in, so it only runs in development.');
    process.exit(1);
  }
  const { createDb } = await import('../src/db/client');
  const { sermons, users } = await import('../src/db/schema');
  const { getEnv } = await import('../src/lib/env');
  const { LOGIN_TOKEN_TTL_MS, issueLoginToken, signInUrl } = await import('../src/lib/auth/login');
  const { canViewSermon } = await import('../src/lib/permissions');

  const env = getEnv();
  const db = createDb(env.DATABASE_URL);
  const browser: Browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  });
  const findings: Finding[] = [];
  let checked = 0;
  try {
    const allSermons = await db
      .select({ id: sermons.id, status: sermons.status, contributorId: sermons.contributorId })
      .from(sermons)
      .where(isNull(sermons.deletedAt))
      .orderBy(asc(sermons.createdAt));

    // Signed out first: the sign-in page.
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${env.APP_URL}/sign-in`);
      findings.push(...(await audit(page, 'viewer', '/sign-in (signed out)')));
      checked++;
      await context.close();
    }

    for (const role of ['viewer', 'contributor', 'admin'] as const) {
      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.role, role), isNull(users.disabledAt)))
        .orderBy(asc(users.createdAt))
        .limit(1);
      if (!user) {
        console.log(`No active ${role}; skipping that role.`);
        continue;
      }
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(
        signInUrl(env.APP_URL, await issueLoginToken(db, user.id, LOGIN_TOKEN_TTL_MS)),
      );
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));

      // One sermon of each status this person can see.
      const seen = new Set<string>();
      const sermonPaths = allSermons
        .filter((s) => canViewSermon(user, { ...s, deleted: false }))
        .filter((s) => !seen.has(s.status) && seen.add(s.status))
        .map((s) => `/sermons/${s.id}`);

      for (const path of [...COMMON, ...BY_ROLE[role], ...sermonPaths]) {
        await page.goto(`${env.APP_URL}${path}`);
        await page.waitForLoadState('networkidle');
        findings.push(...(await audit(page, role, path)));
        checked++;
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await db.close();
  }

  for (const f of findings) {
    console.log(`\n[${f.impact}] ${f.role} ${f.path}: ${f.help} (${f.id})`);
    for (const node of f.nodes.slice(0, 5)) console.log(`    ${node}`);
  }
  console.log(
    `\nChecked ${checked} pages: ${findings.length} problem${findings.length === 1 ? '' : 's'}.`,
  );
  process.exit(findings.length ? 1 : 0);
}

async function audit(
  page: import('playwright-core').Page,
  role: Role,
  path: string,
): Promise<Finding[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((v) => ({
    role,
    path,
    id: v.id,
    impact: v.impact ?? 'unknown',
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')),
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
