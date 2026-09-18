export type DateParse = { ok: true; iso: string } | { ok: false; error: string };

const DATE_HINT = 'Use MM/DD/YYYY, for example 03/13/1988.';

/** Reads the date off a tape label. Accepts 03/13/1988, 3-13-1988 or 1988-03-13. */
export function parseLabelDate(text: string, today = new Date()): DateParse {
  const value = text.trim();
  let year: number, month: number, day: number;
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) {
    [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return { ok: false, error: `That doesn’t look like a date. ${DATE_HINT}` };
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!real) return { ok: false, error: `That date doesn’t exist. ${DATE_HINT}` };
  if (year < 1900 || date.getTime() > today.getTime()) {
    return { ok: false, error: 'The date should be between 1900 and today.' };
  }
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { ok: true, iso };
}

/** Guesses side A or B from names like Tape14_SideA.wav or Box3-Tape2-B.mp3. Only a suggestion. */
export function detectSide(filename: string): 'A' | 'B' | null {
  const stem = filename.replace(/\.[^.]+$/, '');
  const named = stem.match(/side[\s._-]*([ab])(?![a-z])/i);
  if (named) return named[1].toUpperCase() as 'A' | 'B';
  const trailing = stem.match(/(?:^|[\s._-])([ab])$/i);
  return trailing ? (trailing[1].toUpperCase() as 'A' | 'B') : null;
}
