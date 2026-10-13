import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, settings } from '@/db/schema';
import { insertUser, openTestDb, resetTables } from '../../tests/support/db';
import { ForbiddenError } from './errors';
import { getSettings, parseWordList, SETTING_DEFAULTS, updateSettings } from './settings';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

const valid = {
  churchName: 'Grace Fellowship',
  defaultSpeaker: 'Pastor Lee',
  recognitionWords: '',
};

describe('getSettings', () => {
  it('returns defaults before anything is saved', async () => {
    expect(await getSettings(db)).toEqual(SETTING_DEFAULTS);
  });
});

describe('updateSettings', () => {
  it('lets an admin change the church and speaker names', async () => {
    const admin = await insertUser(db, 'admin');
    const result = await updateSettings(db, admin, valid);
    expect(result).toMatchObject({ ok: true, changed: ['churchName', 'defaultSpeaker'] });
    expect(await getSettings(db)).toEqual(valid);
  });

  it('trims whitespace', async () => {
    const admin = await insertUser(db, 'admin');
    await updateSettings(db, admin, { churchName: '  Grace Fellowship  ', defaultSpeaker: '' });
    expect((await getSettings(db)).churchName).toBe('Grace Fellowship');
  });

  it('records who changed what in the audit log', async () => {
    const admin = await insertUser(db, 'admin');
    await updateSettings(db, admin, valid);
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.id,
      action: 'settings.update',
      entity: 'settings',
    });
    expect(rows[0].diff).toEqual({
      churchName: { from: SETTING_DEFAULTS.churchName, to: 'Grace Fellowship' },
      defaultSpeaker: { from: '', to: 'Pastor Lee' },
    });
  });

  it('writes nothing, and no audit entry, when nothing changed', async () => {
    const admin = await insertUser(db, 'admin');
    await updateSettings(db, admin, valid);
    const again = await updateSettings(db, admin, valid);
    expect(again).toMatchObject({ ok: true, changed: [] });
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it.each(['contributor', 'viewer'] as const)('refuses a %s and changes nothing', async (role) => {
    const user = await insertUser(db, role);
    await expect(updateSettings(db, user, valid)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.select().from(settings)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('checks permission before validating, so invalid input from a non-admin is still Forbidden', async () => {
    const user = await insertUser(db, 'contributor');
    await expect(updateSettings(db, user, { churchName: '' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('rejects an empty church name with a field error and writes nothing', async () => {
    const admin = await insertUser(db, 'admin');
    const result = await updateSettings(db, admin, { churchName: '   ', defaultSpeaker: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.churchName).toMatch(/church name/i);
    expect(await db.select().from(settings)).toHaveLength(0);
  });

  it('rejects names over 80 characters', async () => {
    const admin = await insertUser(db, 'admin');
    const result = await updateSettings(db, admin, {
      churchName: 'x'.repeat(81),
      defaultSpeaker: 'y'.repeat(81),
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(Object.keys(result.errors).sort()).toEqual(['churchName', 'defaultSpeaker']);
  });

  it('falls back to the default when a stored value is invalid', async () => {
    await db.insert(settings).values({ key: 'church_name', value: 42 });
    expect((await getSettings(db)).churchName).toBe(SETTING_DEFAULTS.churchName);
    expect(await db.select().from(settings).where(eq(settings.key, 'church_name'))).toHaveLength(1);
  });

  it('saves the words to recognize one per line, tidied, without repeats', async () => {
    const admin = await insertUser(db, 'admin');
    const result = await updateSettings(db, admin, {
      ...valid,
      recognitionWords: '  Shiloh   Baptist \n\nEbenezer, shiloh baptist\nPastor  Haynes ',
    });
    expect(result).toMatchObject({
      ok: true,
      changed: ['churchName', 'defaultSpeaker', 'recognitionWords'],
    });
    expect((await getSettings(db)).recognitionWords).toBe(
      'Shiloh Baptist\nEbenezer\nPastor Haynes',
    );
  });

  it('rejects too many words, or one that is too long', async () => {
    const admin = await insertUser(db, 'admin');
    const many = Array.from({ length: 31 }, (_, i) => `word${i}`).join('\n');
    const tooMany = await updateSettings(db, admin, { ...valid, recognitionWords: many });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.errors.recognitionWords).toMatch(/30 words/);
    const tooLong = await updateSettings(db, admin, { ...valid, recognitionWords: 'x'.repeat(41) });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.errors.recognitionWords).toMatch(/40 characters/);
    expect(await db.select().from(settings)).toHaveLength(0);
  });
});

describe('parseWordList', () => {
  it('splits on lines and commas and keeps the first spelling of a repeat', () => {
    expect(parseWordList('Selah\r\nselah, Maranatha ,, \n')).toEqual(['Selah', 'Maranatha']);
    expect(parseWordList('')).toEqual([]);
  });
});
