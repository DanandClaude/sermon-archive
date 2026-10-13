import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { auditLog, settings } from '@/db/schema';
import { assertCan, type Actor } from './permissions';

/** Most hint words the recognizer is given. Whisper reads only ~220 tokens of hints in all. */
export const MAX_RECOGNITION_WORDS = 30;
const MAX_RECOGNITION_WORD_LENGTH = 40;

/**
 * One word or phrase per line (commas also split). Trims, collapses inner spaces and drops
 * blanks and case-insensitive repeats, keeping the first spelling.
 */
export function parseWordList(text: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const word = raw.trim().replace(/\s+/g, ' ');
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}

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
  // Stored as one word per line; the worker adds them to the transcription prompt.
  recognitionWords: z
    .string()
    .default('')
    .transform((text) => parseWordList(text))
    .refine((words) => words.length <= MAX_RECOGNITION_WORDS, {
      message: `Keep it to ${MAX_RECOGNITION_WORDS} words or fewer.`,
    })
    .refine((words) => words.every((w) => w.length <= MAX_RECOGNITION_WORD_LENGTH), {
      message: `Keep each word or phrase under ${MAX_RECOGNITION_WORD_LENGTH} characters.`,
    })
    .transform((words) => words.join('\n')),
};
export const settingsInputSchema = z.object(fields);
export type AppSettings = z.output<typeof settingsInputSchema>;

export const SETTING_DEFAULTS: AppSettings = {
  churchName: 'Your Church',
  defaultSpeaker: '',
  recognitionWords: '',
};

const KEY_BY_FIELD: Record<keyof AppSettings, string> = {
  churchName: 'church_name',
  defaultSpeaker: 'default_speaker',
  recognitionWords: 'recognition_words',
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
  | { ok: true; changed: (keyof AppSettings)[]; saved: AppSettings }
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
    if (changed.length === 0) return { ok: true as const, changed, saved: next };

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
    return { ok: true as const, changed, saved: next };
  });
}
