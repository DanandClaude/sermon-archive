import referenceCases from '../../../shared/reference-cases.json';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANON,
  findBook,
  formatReference,
  normalizeBookText,
  parseReferenceText,
  resolveBook,
  tagsForBook,
  validateReference,
} from './canon';

const shared = (file: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'shared', file), 'utf8'));
const chapters = (name: string) => findBook(name)!.chapters;

describe('the canon table', () => {
  it('matches the published KJV totals: 66 books, 1,189 chapters, 31,102 verses', () => {
    expect(CANON).toHaveLength(66);
    expect(CANON.reduce((n, b) => n + b.chapters.length, 0)).toBe(1189);
    expect(CANON.reduce((n, b) => n + b.chapters.reduce((a, c) => a + c, 0), 0)).toBe(31102);
  });

  it('agrees with the book list used to prompt the transcriber, in the same order', () => {
    const list = shared('bible-books.json');
    expect(CANON.map((b) => b.name)).toEqual([...list.oldTestament, ...list.newTestament]);
  });

  it('has well-known facts right', () => {
    expect(chapters('Psalms')).toHaveLength(150);
    expect(chapters('Psalms')[118]).toBe(176); // Psalm 119
    expect(chapters('Psalms')[22]).toBe(6); // Psalm 23
    expect(chapters('Hebrews')[12]).toBe(25); // Hebrews 13
    expect(chapters('Romans')[7]).toBe(39); // Romans 8
    expect(chapters('Genesis')).toHaveLength(50);
    expect(chapters('Genesis')[0]).toBe(31);
    expect(chapters('Revelation')).toHaveLength(22);
    expect(chapters('John')).toHaveLength(21);
    expect(chapters('Matthew')).toHaveLength(28);
    expect(chapters('Jude')).toEqual([25]);
    expect(chapters('Obadiah')).toEqual([21]);
    expect(chapters('Philemon')).toEqual([25]);
    expect(chapters('2 John')).toEqual([13]);
    expect(chapters('3 John')).toEqual([14]);
    expect(chapters('John')[2]).toBe(36); // John 3, for John 3:16
  });

  it('files every book under one testament and one of the eight genres', () => {
    expect(CANON.filter((b) => b.testament === 'Old')).toHaveLength(39);
    expect(CANON.filter((b) => b.testament === 'New')).toHaveLength(27);
    const count = (g: string) => CANON.filter((b) => b.genre === g).length;
    expect(
      ['Law', 'History', 'Wisdom', 'Psalm', 'Prophecy', 'Gospel', 'Epistle', 'Apocalyptic'].map(
        count,
      ),
    ).toEqual([5, 13, 4, 1, 17, 4, 21, 1]);
  });

  it('records where the counts came from', () => {
    const { source } = shared('canon.json');
    expect(source.license).toBe('Public domain');
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('resolveBook', () => {
  it('finds every book by its own name', () => {
    for (const book of CANON) expect(resolveBook(book.name)?.name).toBe(book.name);
  });

  it('finds every listed alternate and abbreviation, each pointing at exactly one book', () => {
    const seen = new Map<string, string>();
    for (const [name, entry] of Object.entries<{ alternates: string[]; abbreviations: string[] }>(
      shared('book-aliases.json').books,
    )) {
      for (const spelling of [...entry.alternates, ...entry.abbreviations]) {
        expect(resolveBook(spelling)?.name, spelling).toBe(name);
        expect(seen.get(spelling) ?? name, `${spelling} is claimed by two books`).toBe(name);
        seen.set(spelling, name);
      }
    }
  });

  it.each([
    ['First Peter', '1 Peter'],
    ['1st Peter', '1 Peter'],
    ['I Peter', '1 Peter'],
    ['1Peter', '1 Peter'],
    ['second corinthians', '2 Corinthians'],
    ['III John', '3 John'],
    ['Psalm', 'Psalms'],
    ['Song of Songs', 'Song of Solomon'],
    ['Revelations', 'Revelation'],
    ['Heb.', 'Hebrews'],
    ['  ROMANS ', 'Romans'],
    ['Jn', 'John'],
  ])('reads %j as %s', (input, name) => expect(resolveBook(input)?.name).toBe(name));

  it('does not treat ordinary words as books when reading speech', () => {
    expect(resolveBook('is', { abbreviations: false })).toBeUndefined();
    expect(resolveBook('ex', { abbreviations: false })).toBeUndefined();
    expect(resolveBook('is')?.name).toBe('Isaiah'); // fine for a typed label
    expect(resolveBook('john', { abbreviations: false })?.name).toBe('John');
    expect(resolveBook('first peter', { abbreviations: false })?.name).toBe('1 Peter');
  });

  it.each(['', 'Hezekiah', 'Book of Mormon', 'Tobit', '4 John'])('does not know %j', (input) => {
    expect(resolveBook(input)).toBeUndefined();
  });

  it('normalises ordinals, periods and spacing', () => {
    expect(normalizeBookText('  1st   Sam. ')).toBe('1 sam');
  });
});

describe('validateReference', () => {
  it('accepts valid passages and returns the canonical book name', () => {
    expect(validateReference({ book: 'heb', chapter: 13, verseStart: 17 })).toEqual({
      ok: true,
      ref: { book: 'Hebrews', chapter: 13, verseStart: 17, verseEnd: null },
    });
    expect(
      validateReference({ book: 'Romans', chapter: 8, verseStart: 28, verseEnd: 39 }),
    ).toMatchObject({ ok: true });
    expect(validateReference({ book: 'Psalm', chapter: 23 })).toEqual({
      ok: true,
      ref: { book: 'Psalms', chapter: 23, verseStart: null, verseEnd: null },
    });
  });

  it('treats a range that ends where it starts as a single verse', () => {
    expect(
      validateReference({ book: 'John', chapter: 3, verseStart: 16, verseEnd: 16 }),
    ).toMatchObject({
      ok: true,
      ref: { verseStart: 16, verseEnd: null },
    });
  });

  it.each([
    [{ book: 'Romans', chapter: 99, verseStart: 1 }, /has 16 chapters/],
    [{ book: 'Romans', chapter: 0 }, /has 16 chapters/],
    [{ book: 'Romans', chapter: 1.5 }, /chapters/],
    [{ book: 'Jude', chapter: 2 }, /has 1 chapter\./],
    [{ book: 'Hebrews', chapter: 13, verseStart: 26 }, /has 25 verses/],
    [{ book: 'Hebrews', chapter: 13, verseStart: 0 }, /has 25 verses/],
    [{ book: 'Hebrews', chapter: 13, verseStart: 17, verseEnd: 40 }, /has 25 verses/],
    [{ book: 'Hebrews', chapter: 13, verseStart: 17, verseEnd: 12 }, /can’t come before/],
    [{ book: 'Hebrews', chapter: 13, verseEnd: 5 }, /starting verse/],
    [{ book: 'Hezekiah', chapter: 1 }, /isn’t a book/],
  ])('rejects %j', (input, message) => {
    const result = validateReference(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe('formatReference', () => {
  it.each([
    [{ book: 'Hebrews', chapter: 13, verseStart: 17, verseEnd: null }, 'Hebrews 13:17'],
    [{ book: 'Romans', chapter: 8, verseStart: 28, verseEnd: 39 }, 'Romans 8:28–39'],
    [{ book: '1 Peter', chapter: 5, verseStart: 2, verseEnd: 3 }, '1 Peter 5:2–3'],
    [{ book: 'Psalms', chapter: 23, verseStart: null, verseEnd: null }, 'Psalm 23'],
    [{ book: 'Psalms', chapter: 119, verseStart: 105, verseEnd: null }, 'Psalm 119:105'],
  ])('%j → %s', (ref, text) => expect(formatReference(ref)).toBe(text));
});

describe('parseReferenceText', () => {
  it.each([
    ['Hebrews 13:17', 'Hebrews 13:17'],
    ['Romans 8:28-39', 'Romans 8:28–39'],
    ['Romans 8:28 to 39', 'Romans 8:28–39'],
    ['psalm 23', 'Psalm 23'],
    ['1 John 3:16', '1 John 3:16'],
    ['First Peter 5:2-3', '1 Peter 5:2–3'],
    ['Heb. 13.17', 'Hebrews 13:17'],
    ['Jude 3', 'Jude 1:3'],
    ['3 John 4', '3 John 1:4'],
  ])('reads %j as %s', (text, expected) => {
    const result = parseReferenceText(text);
    expect(result.ok && formatReference(result.ref)).toBe(expected);
  });

  it.each(['', 'Hebrews', 'Hebrews thirteen', 'Nowhere 3:16', 'Romans 99:1', 'Hebrews 13:26'])(
    'rejects %j',
    (text) => {
      expect(parseReferenceText(text).ok).toBe(false);
    },
  );
});

describe('tagsForBook', () => {
  it('gives testament, genre and book tags', () => {
    expect(tagsForBook('Hebrews')).toEqual([
      { kind: 'testament', name: 'New Testament' },
      { kind: 'genre', name: 'Epistle' },
      { kind: 'book', name: 'Hebrews' },
    ]);
    expect(tagsForBook('Psalms')[1]).toEqual({ kind: 'genre', name: 'Psalm' });
    expect(tagsForBook('Nowhere')).toEqual([]);
  });
});

describe('shared reference cases (also run by the Python worker)', () => {
  const { cases } = referenceCases as {
    cases: (
      { text: string; ok: true; ref: unknown } | { text: string; ok: false; error: string }
    )[];
  };

  it.each(cases.map((c) => [c.text || '(empty)', c] as const))('reads %s', (_name, c) => {
    const result = parseReferenceText(c.text);
    expect(result.ok).toBe(c.ok);
    if (c.ok && result.ok) expect(result.ref).toEqual(c.ref);
    if (!c.ok && !result.ok) expect(result.error).toBe(c.error);
  });
});

describe('formatReference and parseReferenceText agree', () => {
  it('reads back everything it writes, for every book', () => {
    for (const book of CANON) {
      const last = book.chapters.length;
      const refs = [
        { book: book.name, chapter: 1, verseStart: null, verseEnd: null },
        { book: book.name, chapter: last, verseStart: 1, verseEnd: null },
        { book: book.name, chapter: last, verseStart: 1, verseEnd: book.chapters[last - 1] },
      ]
        .filter((r) => r.verseEnd === null || r.verseEnd > 1)
        // "Jude 1" is read as verse 1, so a whole chapter of a one-chapter book can't round-trip.
        .filter((r) => last > 1 || r.verseStart !== null);
      for (const ref of refs) {
        const text = formatReference(ref);
        const back = parseReferenceText(text);
        // A one-chapter book written as "Jude 3" means verse 3, so compare what it means.
        expect(back.ok, text).toBe(true);
        if (back.ok) expect(back.ref, text).toEqual(ref);
      }
    }
  });
});
