/** Pure file-name rules. No database, so the review screen can preview a name in the browser. */
import type { Reference } from '@/lib/scripture/canon';

export const MAX_TITLE_CHARS = 40;

/** Words kept lower-case inside a title, as in "Submitting-to-Leaders". */
const SMALL_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'vs',
  'with',
]);

/** Removes accents and anything that isn't a letter or digit; words are separated by single spaces. */
function plainWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’‘`]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** "submitting to leaders" -> "Submitting-to-Leaders", capped at about 40 characters at a word boundary. */
export function titleSlug(title: string | null | undefined): string {
  const words = plainWords(title ?? '').map((w, i) => {
    const lower = w.toLowerCase();
    return i > 0 && SMALL_WORDS.has(lower) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  if (words.length === 0) return 'Untitled';
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_TITLE_CHARS) break;
    slug = next;
  }
  return slug || words[0].slice(0, MAX_TITLE_CHARS);
}

function textSlug(text: string | null | undefined): string {
  return plainWords(text ?? '').join('-');
}

/** Hebrews 13:17 -> "Hebrews-13-17", Romans 8:28-39 -> "Romans-8-28-39", Psalms 23 -> "Psalm-23". */
export function passageSlug(ref: Reference | null): string {
  if (!ref) return 'Passage-Needed';
  const book = plainWords(ref.book === 'Psalms' ? 'Psalm' : ref.book).join('-');
  const parts: (string | number)[] = [book, ref.chapter];
  if (ref.verseStart !== null) parts.push(ref.verseStart);
  if (ref.verseEnd !== null) parts.push(ref.verseEnd);
  return parts.join('-');
}

export type StemInput = {
  /** YYYY-MM-DD, from the tape label or set by a person. */
  recordedOn: string | null;
  passage: Reference | null;
  title: string | null;
  /** Used only when there is no date: undated_<batch>-<tape>. */
  batchLabel?: string | null;
  originalFilename?: string | null;
};

/** YYYY-MM-DD_Book-Chapter-Verse_ShortTitle, or undated_<batch>-<tape>_... when the date is missing. */
export function filenameStem(input: StemInput): string {
  const tape = textSlug(input.originalFilename?.replace(/\.[^.]+$/, '')) || 'tape';
  const date = input.recordedOn?.match(/^\d{4}-\d{2}-\d{2}$/)
    ? input.recordedOn
    : `undated_${textSlug(input.batchLabel) || 'unsorted'}-${tape}`;
  return `${date}_${passageSlug(input.passage)}_${titleSlug(input.title)}`;
}

/** Second and later sermons with the same stem get _2, _3, and so on. */
export function withSuffix(stem: string, n: number): string {
  return n <= 1 ? stem : `${stem}_${n}`;
}
