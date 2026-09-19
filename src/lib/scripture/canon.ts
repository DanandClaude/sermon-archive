import aliases from '../../../shared/book-aliases.json';
import canonData from '../../../shared/canon.json';

export type Testament = 'Old' | 'New';
export type Genre =
  'Law' | 'History' | 'Wisdom' | 'Psalm' | 'Prophecy' | 'Gospel' | 'Epistle' | 'Apocalyptic';

export type CanonBook = {
  name: string;
  testament: Testament;
  genre: Genre;
  /** Verses in each chapter: chapters[0] is chapter 1. */
  chapters: number[];
};

/** The 66-book Protestant canon with chapter and verse counts derived from the public-domain KJV. */
export const CANON = canonData.books as CanonBook[];

const BY_NAME = new Map(CANON.map((b) => [b.name.toLowerCase(), b]));

export function findBook(name: string): CanonBook | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

const SPELLINGS = new Map<string, CanonBook>();
const ABBREVIATIONS = new Map<string, CanonBook>();
for (const book of CANON) {
  SPELLINGS.set(book.name.toLowerCase(), book);
  const entry = (
    aliases.books as Record<string, { alternates: string[]; abbreviations: string[] }>
  )[book.name];
  for (const alt of entry.alternates) SPELLINGS.set(alt, book);
  for (const abbr of entry.abbreviations) ABBREVIATIONS.set(abbr, book);
}

const ORDINALS: [RegExp, string][] = [
  [/^(first|1st|i)\s+/, '1 '],
  [/^(second|2nd|ii)\s+/, '2 '],
  [/^(third|3rd|iii)\s+/, '3 '],
  [/^([123])(?=[a-z])/, '$1 '],
];

/** Lower-cases, drops periods, tidies spaces and turns "First", "1st", "I" and "1Peter" into "1 ...". */
export function normalizeBookText(input: string): string {
  let text = input.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of ORDINALS) {
    if (pattern.test(text)) {
      text = text.replace(pattern, replacement);
      break;
    }
  }
  return text;
}

/**
 * Finds a book from how someone wrote or said it. Abbreviations (Gen, Heb, Jn) are only accepted
 * for typed input: in speech, a bare "is" or "ex" is an ordinary word, not a book.
 */
export function resolveBook(
  input: string,
  options: { abbreviations?: boolean } = {},
): CanonBook | undefined {
  const text = normalizeBookText(input);
  return (
    SPELLINGS.get(text) ?? (options.abbreviations === false ? undefined : ABBREVIATIONS.get(text))
  );
}

/** A passage: a book, a chapter, and optionally a verse or verse range. No verses means the whole chapter. */
export type Reference = {
  book: string;
  chapter: number;
  verseStart: number | null;
  verseEnd: number | null;
};

export type Validation = { ok: true; ref: Reference } | { ok: false; error: string };

export function validateReference(input: {
  book: string;
  chapter: number;
  verseStart?: number | null;
  verseEnd?: number | null;
}): Validation {
  const book = resolveBook(input.book);
  if (!book) return { ok: false, error: `“${input.book}” isn’t a book of the Bible.` };
  const { chapter } = input;
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > book.chapters.length) {
    return {
      ok: false,
      error: `${book.name} has ${book.chapters.length} chapter${book.chapters.length === 1 ? '' : 's'}.`,
    };
  }
  const verses = book.chapters[chapter - 1];
  const start = input.verseStart ?? null;
  const end = input.verseEnd ?? null;
  if (start === null) {
    if (end !== null)
      return { ok: false, error: 'Give a starting verse as well as an ending verse.' };
    return { ok: true, ref: { book: book.name, chapter, verseStart: null, verseEnd: null } };
  }
  if (!Number.isInteger(start) || start < 1 || start > verses) {
    return {
      ok: false,
      error: `${book.name} ${chapter} has ${verses} verse${verses === 1 ? '' : 's'}.`,
    };
  }
  if (end !== null && (!Number.isInteger(end) || end < start || end > verses)) {
    return {
      ok: false,
      error:
        end < start
          ? 'The ending verse can’t come before the starting verse.'
          : `${book.name} ${chapter} has ${verses} verses.`,
    };
  }
  return {
    ok: true,
    ref: { book: book.name, chapter, verseStart: start, verseEnd: end === start ? null : end },
  };
}

/** "Romans 8:28–39", "1 Peter 5:2–3", "Hebrews 13:17", "Psalm 23". */
export function formatReference(ref: Reference): string {
  const name = ref.book === 'Psalms' ? 'Psalm' : ref.book;
  if (ref.verseStart === null) return `${name} ${ref.chapter}`;
  const verses = ref.verseEnd === null ? `${ref.verseStart}` : `${ref.verseStart}–${ref.verseEnd}`;
  return `${name} ${ref.chapter}:${verses}`;
}

const RANGE_WORDS = '(?:-|–|—|to|through|thru)';
const REFERENCE_TEXT = new RegExp(
  `^(.+?)\\s+(\\d+)(?:\\s*[:.]\\s*(\\d+)(?:\\s*${RANGE_WORDS}\\s*(\\d+))?)?$`,
  'i',
);

/** "Jude 3-5": a verse range in a book with one chapter, written without the chapter. */
const ONE_CHAPTER_RANGE = new RegExp(`^(.+?)\\s+(\\d+)\\s*${RANGE_WORDS}\\s*(\\d+)$`, 'i');

/**
 * Reads a passage someone typed, such as a tape label: "Hebrews 13:17", "Romans 8:28-39",
 * "Psalm 23", "1 John 3:16". For a one-chapter book, "Jude 3" means verse 3.
 */
export function parseReferenceText(text: string): Validation {
  const trimmed = text.trim();
  const match = trimmed.match(REFERENCE_TEXT);
  const bare = trimmed.match(ONE_CHAPTER_RANGE);
  if (bare) {
    const book = resolveBook(bare[1]);
    if (book?.chapters.length === 1) {
      return validateReference({
        book: book.name,
        chapter: 1,
        verseStart: Number(bare[2]),
        verseEnd: Number(bare[3]),
      });
    }
  }
  if (!match) return { ok: false, error: 'Write it like “Hebrews 13:17” or “Psalm 23”.' };
  const book = resolveBook(match[1]);
  if (!book) return { ok: false, error: `“${match[1].trim()}” isn’t a book of the Bible.` };
  const first = Number(match[2]);
  if (match[3] === undefined && book.chapters.length === 1) {
    return validateReference({ book: book.name, chapter: 1, verseStart: first });
  }
  return validateReference({
    book: book.name,
    chapter: first,
    verseStart: match[3] === undefined ? null : Number(match[3]),
    verseEnd: match[4] === undefined ? null : Number(match[4]),
  });
}

/** The testament, genre and book tags a passage brings with it. */
export function tagsForBook(
  bookName: string,
): { kind: 'testament' | 'genre' | 'book'; name: string }[] {
  const book = findBook(bookName);
  if (!book) return [];
  return [
    { kind: 'testament', name: `${book.testament} Testament` },
    { kind: 'genre', name: book.genre },
    { kind: 'book', name: book.name },
  ];
}
