import { describe, expect, it } from 'vitest';
import {
  buildCues,
  formatTimestamp,
  MAX_CUE_CHARS,
  MAX_CUE_SECONDS,
  MAX_LINE,
  toSrt,
  toText,
  toVtt,
  wrapLines,
  type Segment,
  type Word,
} from './render';

const words = (text: string, start = 0, per = 0.4): Word[] =>
  text
    .split(' ')
    .map((w, i) => ({ w, start: start + i * per, end: start + (i + 1) * per, prob: 0.9 }));
const seg = (text: string, start = 0, per = 0.4): Segment => {
  const w = words(text, start, per);
  return { start, end: w[w.length - 1].end, text, words: w };
};

describe('formatTimestamp', () => {
  it.each([
    [0, ',', '00:00:00,000'],
    [83.5, ',', '00:01:23,500'],
    [83.5, '.', '00:01:23.500'],
    [3599.9996, ',', '01:00:00,000'],
    [3725.042, '.', '01:02:05.042'],
    [-2, ',', '00:00:00,000'],
  ] as const)('%s → %s', (seconds, sep, text) => expect(formatTimestamp(seconds, sep)).toBe(text));
});

describe('wrapLines', () => {
  it('leaves a short line alone', () => {
    expect(wrapLines('Turn to Hebrews')).toBe('Turn to Hebrews');
  });
  it('wraps at spaces into lines of at most 42 characters', () => {
    const wrapped = wrapLines(
      'Obey them that have the rule over you, and submit yourselves, for they watch',
    );
    expect(wrapped.split('\n').every((l) => l.length <= MAX_LINE)).toBe(true);
    expect(wrapped.replace(/\n/g, ' ')).toBe(
      'Obey them that have the rule over you, and submit yourselves, for they watch',
    );
  });
  it('never breaks inside a word', () => {
    expect(wrapLines('x'.repeat(60))).toBe('x'.repeat(60));
  });
});

describe('buildCues', () => {
  it('keeps a short segment as one cue with its own timing', () => {
    expect(buildCues([seg('Turn to Hebrews thirteen', 4)])).toEqual([
      { start: 4, end: 5.6, text: 'Turn to Hebrews thirteen' },
    ]);
  });

  it('splits a long segment so no cue is over two lines or six seconds', () => {
    const long = seg(Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '), 10, 0.5);
    const cues = buildCues([long]);
    expect(cues.length).toBeGreaterThan(3);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(MAX_CUE_CHARS);
      expect(cue.end - cue.start).toBeLessThanOrEqual(MAX_CUE_SECONDS + 0.01);
    }
  });

  it('keeps every word, in order', () => {
    const text = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    expect(
      buildCues([seg(text, 0, 0.3)])
        .map((c) => c.text)
        .join(' '),
    ).toBe(text);
  });

  it('starts a new cue after a sentence ends once the line has some length', () => {
    const cues = buildCues([
      seg('Turn with me to Hebrews thirteen. Obey them that have the rule over you.'),
    ]);
    expect(cues.map((c) => c.text)).toEqual([
      'Turn with me to Hebrews thirteen.',
      'Obey them that have the rule over you.',
    ]);
  });

  it('never overlaps cues or runs backwards', () => {
    const cues = buildCues([
      seg('one two three four five six seven eight', 0, 1.2),
      seg('nine ten', 10, 0.5),
    ]);
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i].end).toBeGreaterThan(cues[i].start);
      if (i > 0) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].start);
    }
  });

  it('gives a zero-length word a readable minimum', () => {
    const [cue] = buildCues([
      { start: 1, end: 1, text: 'Amen', words: [{ w: 'Amen', start: 1, end: 1, prob: 1 }] },
    ]);
    expect(cue.end - cue.start).toBeGreaterThanOrEqual(0.3);
  });

  it('spreads the words of a segment that has no word timings', () => {
    const cues = buildCues([{ start: 0, end: 10, text: 'a b c d e f g h i j', words: [] }]);
    expect(cues[0].start).toBe(0);
    expect(cues.map((c) => c.text).join(' ')).toBe('a b c d e f g h i j');
  });

  it('skips empty segments and handles no segments', () => {
    expect(buildCues([{ start: 0, end: 1, text: '  ', words: [] }])).toEqual([]);
    expect(buildCues([])).toEqual([]);
  });
});

describe('toSrt', () => {
  it('numbers cues and uses comma milliseconds', () => {
    const srt = toSrt([seg('Turn to Hebrews', 0), seg('Amen', 5)]);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,200\nTurn to Hebrews\n\n2\n00:00:05,000 --> 00:00:05,400\nAmen\n',
    );
  });
  it('is empty for an empty transcript', () => {
    expect(toSrt([])).toBe('');
  });
});

describe('toVtt', () => {
  it('starts with the WEBVTT header and uses dot milliseconds', () => {
    const vtt = toVtt([seg('Amen', 61.5)]);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:01:01.500 --> 00:01:01.900\nAmen');
    expect(vtt).not.toMatch(/,\d{3} -->/);
  });
});

describe('toText', () => {
  it('joins speech and starts a new paragraph after a pause', () => {
    const text = toText([seg('Turn to Hebrews.', 0), seg('Obey them.', 1.6), seg('Amen.', 20)]);
    expect(text).toBe('Turn to Hebrews. Obey them.\n\nAmen.\n');
  });
  it('is empty for an empty transcript', () => {
    expect(toText([])).toBe('');
  });
});
