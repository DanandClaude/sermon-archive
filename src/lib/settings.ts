import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { auditLog, settings } from '@/db/schema';
import { assertCan, type Actor } from './permissions';

/**
 * Known settings. Church and speaker names are settings, never hardcoded, because the
 * app may be offered to other churches. One deployment serves one church.
 */
const fields = {
  churchName: z
    .string()
    .trim()
    .min(1, 'Enter your church name.')
    .max(80, 'Keep it under 80 characters.'),
  defaultSpeaker: z.string().trim().max(80, 'Keep it under 80 characters.'),
};
export const settingsInputSchema = z.object(fields);
export type AppSettings = z.infer<typeof settingsInputSchema>;

export const SETTING_DEFAULTS: AppSettings = { churchName: 'Your Church', defaultSpeaker: '' };

const KEY_BY_FIELD: Record<keyof AppSettings, string> = {
  churchName: 'church_name',
  defaultSpeaker: 'default_speaker',
};
const FIELDS = Object.keys(KEY_BY_FIELD) as (keyof AppSettings)[];

type Row = { key: string; value: unknown };

function fromRows(rows: Row[]): AppSettings {
  const result = { ...SETTING_DEFAULTS };
  for (const field of FIELDS) {
    const row = rows.find((r) => r.key === KEY_BY_FIELD[field]);
    const parsed = fields[field].safeParse(row?.value);
    if (parsed.success) result[field] = parsed.data;
  }
  return result;
}

export async function getSettings(db: Db): Promise<AppSettings> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, Object.values(KEY_BY_FIELD)));
  return fromRows(rows);
}

export type UpdateSettingsResult =
  | { ok: true; changed: (keyof AppSettings)[] }
  | { ok: false; errors: Partial<Record<keyof AppSettings, string>> };

/**
 * Admin-only. Permission is checked before validation, so a non-admin learns nothing about
 * the rules. Changed values and the actor are written to the audit log in the same transaction.
 */
export async function updateSettings(
  db: Db,
  actor: Actor,
  input: unknown,
): Promise<UpdateSettingsResult> {
  assertCan(actor.role, 'settings.manage');

  const parsed = settingsInputSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Partial<Record<keyof AppSettings, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof AppSettings;
      if (FIELDS.includes(field)) errors[field] ??= issue.message;
    }
    return { ok: false, errors };
  }
  const next = parsed.data;

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, Object.values(KEY_BY_FIELD)))
      .for('update');
    const current = fromRows(rows);
    const changed = FIELDS.filter((field) => current[field] !== next[field]);
    if (changed.length === 0) return { ok: true as const, changed };

    for (const field of changed) {
      await tx
        .insert(settings)
        .values({ key: KEY_BY_FIELD[field], value: next[field], updatedBy: actor.id })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: next[field], updatedBy: actor.id, updatedAt: sql`now()` },
        });
    }
    const diff = Object.fromEntries(changed.map((f) => [f, { from: current[f], to: next[f] }]));
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'settings.update',
      entity: 'settings',
      entityId: 'church_profile',
      diff,
    });
    return { ok: true as const, changed };
  });
}
