import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sermons } from '@/db/schema';
import { insertUser, openTestDb, resetTables } from '../../tests/support/db';
import { filenameStem, passageSlug, titleSlug, uniqueStem, withSuffix } from './naming';

const ref = (
  book: string,
  chapter: number,
  verseStart: number | null = null,
  verseEnd: number | null = null,
) => ({
  book,
  chapter,
  verseStart,
  verseEnd,
});

describe('filenameStem: the examples from the design mockups', () => {
  it.each([
    [
      { recordedOn: '1988-03-13', passage: ref('Hebrews', 13, 17), title: 'Submitting to Leaders' },
      '1988-03-13_Hebrews-13-17_Submitting-to-Leaders',
    ],
    [
      {
        recordedOn: '1991-09-22',
        passage: ref('Romans', 8, 28, 39),
        title: 'More Than Conquerors',
      },
      '1991-09-22_Romans-8-28-39_More-Than-Conquerors',
    ],
    [
      { recordedOn: '1985-06-09', passage: ref('Psalms', 23), title: 'The Shepherd’s Care' },
      '1985-06-09_Psalm-23_The-Shepherds-Care',
    ],
    [
      { recordedOn: '1994-11-06', passage: ref('John', 15, 1, 8), title: 'Abiding in the Vine' },
      '1994-11-06_John-15-1-8_Abiding-in-the-Vine',
    ],
    [
      { recordedOn: '1996-04-14', passage: ref('Luke', 24, 13, 35), title: 'Road to Emmaus' },
      '1996-04-14_Luke-24-13-35_Road-to-Emmaus',
    ],
    [
      { recordedOn: '1993-12-05', passage: ref('Isaiah', 9, 1, 7), title: 'Unto Us a Child' },
      '1993-12-05_Isaiah-9-1-7_Unto-Us-a-Child',
    ],
  ])('%#', (input, expected) => expect(filenameStem(input)).toBe(expected));
});

describe('passageSlug', () => {
  it.each([
    [ref('1 Peter', 5, 2, 3), '1-Peter-5-2-3'],
    [ref('Song of Solomon', 2, 1), 'Song-of-Solomon-2-1'],
    [ref('Psalms', 23), 'Psalm-23'],
    [ref('Jude', 1, 3), 'Jude-1-3'],
    [ref('Romans', 8), 'Romans-8'],
    [null, 'Passage-Needed'],
  ])('%j -> %s', (r, slug) => expect(passageSlug(r)).toBe(slug));
});

describe('titleSlug', () => {
  it('title-cases with hyphens, keeping small words lower-case except at the start', () => {
    expect(titleSlug('the walk of the just')).toBe('The-Walk-of-the-Just');
    expect(titleSlug('to obey and to submit')).toBe('To-Obey-and-to-Submit');
  });

  it('strips punctuation, apostrophes and accents', () => {
    expect(titleSlug('Don’t Lose Heart: A Message (Part 2)!')).toBe(
      'Dont-Lose-Heart-a-Message-Part-2',
    );
    expect(titleSlug('Café résumé naïve')).toBe('Cafe-Resume-Naive');
    expect(titleSlug('  spaced   out  ')).toBe('Spaced-Out');
  });

  it('caps at about 40 characters without cutting a word', () => {
    const slug = titleSlug('The Incomparable Excellence of Christ Our Great High Priest Forever');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe('The-Incomparable-Excellence-of-Christ');
    expect(titleSlug('Supercalifragilisticexpialidocious'.repeat(2)).length).toBe(40);
  });

  it.each([null, undefined, '', '   ', '!!!', '日本語'])('falls back to Untitled for %j', (t) => {
    expect(titleSlug(t)).toBe('Untitled');
  });
});

describe('filenameStem for a sermon with no date', () => {
  it('uses undated_<batch>-<tape> from the batch label and file name', () => {
    expect(
      filenameStem({
        recordedOn: null,
        passage: ref('Hebrews', 13, 17),
        title: 'Submitting to Leaders',
        batchLabel: 'Box 3',
        originalFilename: 'Tape14_SideA.wav',
      }),
    ).toBe('undated_Box-3-Tape14-SideA_Hebrews-13-17_Submitting-to-Leaders');
  });

  it('still makes a stem with no batch and no file name', () => {
    expect(filenameStem({ recordedOn: null, passage: null, title: null })).toBe(
      'undated_unsorted-tape_Passage-Needed_Untitled',
    );
  });

  it('treats a malformed date as missing', () => {
    expect(filenameStem({ recordedOn: '03/13/1988', passage: null, title: 'x' })).toMatch(
      /^undated_/,
    );
  });
});

describe('withSuffix', () => {
  it('leaves the first alone and numbers the rest from 2', () => {
    expect(withSuffix('a_b_c', 1)).toBe('a_b_c');
    expect(withSuffix('a_b_c', 2)).toBe('a_b_c_2');
    expect(withSuffix('a_b_c', 10)).toBe('a_b_c_10');
  });
});

describe('uniqueStem', () => {
  const db = openTestDb();
  afterAll(() => db.close());
  beforeEach(() => resetTables(db));

  async function sermonWithStem(stem: string, over: Partial<typeof sermons.$inferInsert> = {}) {
    const owner = await insertUser(db, 'contributor');
    const [s] = await db
      .insert(sermons)
      .values({ contributorId: owner.id, filenameStem: stem, ...over })
      .returning();
    return s;
  }

  it('returns the stem itself when it is free', async () => {
    const s = await sermonWithStem('other');
    expect(await uniqueStem(db, 'a_b_c', s.id)).toBe('a_b_c');
  });

  it('adds _2 then _3 when the stem is taken', async () => {
    const me = await sermonWithStem('placeholder');
    await sermonWithStem('a_b_c');
    expect(await uniqueStem(db, 'a_b_c', me.id)).toBe('a_b_c_2');
    await sermonWithStem('a_b_c_2');
    expect(await uniqueStem(db, 'a_b_c', me.id)).toBe('a_b_c_3');
  });

  it('does not collide with itself, so re-saving keeps its own stem', async () => {
    const s = await sermonWithStem('a_b_c');
    expect(await uniqueStem(db, 'a_b_c', s.id)).toBe('a_b_c');
  });

  it('ignores deleted sermons', async () => {
    const me = await sermonWithStem('mine');
    await sermonWithStem('a_b_c', { deletedAt: new Date() });
    expect(await uniqueStem(db, 'a_b_c', me.id)).toBe('a_b_c');
  });

  it('does not mistake a longer stem for a collision', async () => {
    const me = await sermonWithStem('mine');
    await sermonWithStem('a_b_c-extra');
    await sermonWithStem('a_b_cd');
    expect(await uniqueStem(db, 'a_b_c', me.id)).toBe('a_b_c');
  });

  it('treats underscores and percent signs in a stem literally', async () => {
    const me = await sermonWithStem('mine');
    await sermonWithStem('aXbXc');
    expect(await uniqueStem(db, 'a_b_c', me.id)).toBe('a_b_c');
  });
});
