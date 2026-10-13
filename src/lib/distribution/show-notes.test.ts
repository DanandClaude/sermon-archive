import { describe, expect, it } from 'vitest';
import {
  byline,
  clip,
  passageLines,
  podcastNotesHtml,
  podcastNotesText,
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  youtubeDescription,
  youtubeTitle,
  type NotesInput,
} from './show-notes';

const base: NotesInput = {
  title: 'Submitting to Leaders',
  recordedOn: '1988-03-13',
  speaker: 'J. Smith',
  churchName: 'Grace Church',
  summary: 'On obeying those who watch for your souls.',
  passages: [
    {
      ref: { book: 'Hebrews', chapter: 13, verseStart: 17, verseEnd: null },
      spokenAtSec: 754,
      isMainText: true,
    },
    {
      ref: { book: 'Romans', chapter: 13, verseStart: 1, verseEnd: 7 },
      spokenAtSec: 1830,
      isMainText: false,
    },
  ],
  transcriptText: 'Turn with me to Hebrews chapter thirteen.',
};
const bytes = (t: string) => new TextEncoder().encode(t).length;

describe('clip', () => {
  it('keeps text that fits and cuts at a word boundary otherwise', () => {
    expect(clip('one two', (t) => t.length <= 10)).toBe('one two');
    expect(clip('one two three four', (t) => t.length <= 10)).toBe('one two…');
    expect(clip('unbreakable', (t) => t.length <= 3)).toBe('');
  });
});

describe('youtube text', () => {
  it('lists passages with the main text marked and the time it was named', () => {
    expect(passageLines(base)).toEqual([
      'Hebrews 13:17 (main text), at 12:34',
      'Romans 13:1–7, at 30:30',
    ]);
  });

  it('writes the byline from what is known', () => {
    expect(byline(base)).toMatch(/^Recorded .*1988\. J\. Smith\. Grace Church\.$/);
    expect(byline({ ...base, recordedOn: null, speaker: ' ' })).toBe('Grace Church.');
  });

  it('keeps titles within 100 characters and drops angle brackets', () => {
    expect(youtubeTitle({ ...base, title: 'A <b>bold</b> title' })).toBe('A bbold/b title');
    const long = youtubeTitle({ ...base, title: 'word '.repeat(40) });
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith('…')).toBe(true);
    expect(youtubeTitle({ ...base, title: '  ' })).toBe('Sermon');
  });

  it('puts the summary, scripture, byline and a transcript excerpt in the description', () => {
    const d = youtubeDescription(base);
    expect(d.indexOf('On obeying')).toBe(0);
    expect(d).toContain('Scripture\nHebrews 13:17 (main text), at 12:34');
    expect(d).toContain('From the transcript\nTurn with me');
    expect(d).not.toMatch(/[<>]/);
  });

  it('never goes over 5,000 bytes, even with long multi-byte text', () => {
    const d = youtubeDescription({
      ...base,
      summary: 'Grâce “quoted” '.repeat(200),
      transcriptText: 'é '.repeat(10_000),
    });
    expect(bytes(d)).toBeLessThanOrEqual(YOUTUBE_DESCRIPTION_MAX_BYTES);
    const withRoom = youtubeDescription({ ...base, transcriptText: 'word '.repeat(5000) });
    expect(bytes(withRoom)).toBeLessThanOrEqual(YOUTUBE_DESCRIPTION_MAX_BYTES);
    expect(withRoom.split('From the transcript\n')[1].length).toBeLessThanOrEqual(2500);
  });

  it('leaves out sections it has nothing for', () => {
    const d = youtubeDescription({ ...base, summary: null, passages: [], transcriptText: null });
    expect(d).toBe(byline(base));
  });
});

describe('podcast notes', () => {
  it('has the same parts as text and as escaped HTML', () => {
    const notes = { ...base, summary: 'First & <second>.\n\nAnother paragraph.' };
    expect(podcastNotesText(notes)).toContain('Scripture:\n- Hebrews 13:17 (main text), at 12:34');
    const html = podcastNotesHtml(notes);
    expect(html).toContain('<p>First &amp; &lt;second&gt;.</p><p>Another paragraph.</p>');
    expect(html).toContain('<li>Romans 13:1–7, at 30:30</li>');
  });
});
