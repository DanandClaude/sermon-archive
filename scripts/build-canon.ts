/**
 * Builds shared/canon.json (chapter and verse counts for the 66-book Protestant canon) from the
 * Project Gutenberg King James Bible, which is in the public domain. The counts are derived from
 * the text, never typed from memory, and checked against the known KJV totals.
 *
 *   curl -o kjv.txt https://www.gutenberg.org/cache/epub/10/pg10.txt
 *   npx tsx scripts/build-canon.ts kjv.txt
 *
 * Only the derived counts are committed, not the text.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const books = JSON.parse(
  readFileSync(join(process.cwd(), 'shared', 'bible-books.json'), 'utf8'),
) as {
  oldTestament: string[];
  newTestament: string[];
};
const names = [...books.oldTestament, ...books.newTestament];

/** Genre for each book, in canon order: the categories in SPEC §4.3. */
function genreOf(index: number, name: string): string {
  if (index < 5) return 'Law';
  if (name === 'Psalms') return 'Psalm';
  if (['Job', 'Proverbs', 'Ecclesiastes', 'Song of Solomon'].includes(name)) return 'Wisdom';
  if (index < 17) return 'History'; // Joshua to Esther
  if (index < 39) return 'Prophecy'; // Isaiah to Malachi (Lamentations and Daniel included)
  if (index < 43) return 'Gospel';
  if (name === 'Acts') return 'History';
  if (name === 'Revelation') return 'Apocalyptic';
  return 'Epistle';
}

const file = process.argv[2];
if (!file) throw new Error('Usage: npx tsx scripts/build-canon.ts <path to Gutenberg kjv.txt>');
const raw = readFileSync(file);
const sha256 = createHash('sha256').update(raw).digest('hex');
const text = raw.toString('utf8');

const start = text.indexOf('*** START OF');
const end = text.indexOf('*** END OF');
if (start < 0 || end < 0)
  throw new Error('Not a Project Gutenberg text: start/end markers missing.');
const lines = text.slice(text.indexOf('\n', start) + 1, end).split(/\r?\n/);

// The table of contents lists the 66 book headings in order, after the two testament titles.
const tocHeadings = lines
  .filter((l) => l.trim() && !/^The (Old|New) Testament/.test(l))
  .slice(0, 66)
  .map((l) => l.trim());
if (tocHeadings.length !== 66) throw new Error(`Expected 66 headings, found ${tocHeadings.length}`);

// Body: each heading appears again where its book starts (after the table of contents).
const tocEnd = lines.findIndex((l) => l.trim() === tocHeadings[65]) + 1;
const starts: number[] = [];
let cursor = tocEnd;
for (const heading of tocHeadings) {
  const at = lines.findIndex((l, i) => i >= cursor && l.trim() === heading);
  if (at < 0) throw new Error(`Heading not found in the body: ${heading}`);
  starts.push(at);
  cursor = at + 1;
}

const out = names.map((name, i) => {
  const section = lines.slice(starts[i] + 1, i === 65 ? lines.length : starts[i + 1]).join('\n');
  const verses = new Map<number, number[]>();
  for (const m of section.matchAll(/(?:^|\s)(\d{1,3}):(\d{1,3})(?=\s)/g)) {
    const chapter = Number(m[1]);
    (verses.get(chapter) ?? verses.set(chapter, []).get(chapter)!).push(Number(m[2]));
  }
  const chapterNumbers = [...verses.keys()].sort((a, b) => a - b);
  chapterNumbers.forEach((c, k) => {
    if (c !== k + 1)
      throw new Error(`${name}: chapters are not 1..N (saw ${chapterNumbers.join(',')})`);
  });
  const counts = chapterNumbers.map((c) => {
    const list = verses.get(c)!;
    list.forEach((v, k) => {
      if (v !== k + 1)
        throw new Error(`${name} ${c}: verses are not 1..N in order (saw ${list.join(',')})`);
    });
    return list.length;
  });
  return {
    name,
    testament: i < 39 ? 'Old' : 'New',
    genre: genreOf(i, name),
    chapters: counts,
  };
});

const totals = {
  books: out.length,
  chapters: out.reduce((n, b) => n + b.chapters.length, 0),
  verses: out.reduce((n, b) => n + b.chapters.reduce((a, c) => a + c, 0), 0),
};
// Well-known KJV totals. If the text or the parsing were wrong, these would not match.
if (totals.books !== 66 || totals.chapters !== 1189 || totals.verses !== 31102) {
  throw new Error(`Totals do not match the KJV: ${JSON.stringify(totals)}`);
}

writeFileSync(
  join(process.cwd(), 'shared', 'canon.json'),
  JSON.stringify(
    {
      _comment:
        'Chapter and verse counts for the 66-book Protestant canon, derived by scripts/build-canon.ts from the public-domain King James Bible. Do not edit by hand.',
      source: {
        name: 'The King James Version of the Bible, Project Gutenberg ebook #10',
        url: 'https://www.gutenberg.org/cache/epub/10/pg10.txt',
        license: 'Public domain',
        sha256,
      },
      totals,
      books: out,
    },
    null,
    1,
  ) + '\n',
);
console.log(
  `canon.json written: ${totals.books} books, ${totals.chapters} chapters, ${totals.verses} verses (sha256 ${sha256.slice(0, 12)}…)`,
);
