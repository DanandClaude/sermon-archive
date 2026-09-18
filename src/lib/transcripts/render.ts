export type Word = { w: string; start: number; end: number; prob: number };
export type Segment = { start: number; end: number; text: string; words: Word[] };
export type Cue = { start: number; end: number; text: string };

/** Caption rules: at most two lines of 42 characters, and no cue longer than 6 seconds. */
export const MAX_LINE = 42;
export const MAX_CUE_CHARS = MAX_LINE * 2;
export const MAX_CUE_SECONDS = 6;
const MIN_CUE_SECONDS = 0.3;

/** 83.5 → '00:01:23,500' (SRT) or '00:01:23.500' (VTT). */
export function formatTimestamp(seconds: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

/** Breaks text into lines of at most MAX_LINE characters, at spaces. A single longer word stays whole. */
export function wrapLines(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > MAX_LINE) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

const endsSentence = (w: string) => /[.?!]["')\]]*$/.test(w);

function cuesFromWords(words: Word[]): Cue[] {
  const cues: Cue[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.w).join(' '),
    });
    current = [];
  };
  for (const word of words) {
    if (current.length > 0) {
      const chars = current.map((w) => w.w).join(' ').length + 1 + word.w.length;
      const tooLong = chars > MAX_CUE_CHARS || word.end - current[0].start > MAX_CUE_SECONDS;
      const sentenceBreak = endsSentence(current[current.length - 1].w) && chars > MAX_LINE / 2;
      if (tooLong || sentenceBreak) flush();
    }
    current.push(word);
  }
  flush();
  return cues;
}

/** Caption cues from word timings (or, for a segment without words, from its text). */
export function buildCues(segments: Segment[]): Cue[] {
  const cues: Cue[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    if (segment.words.length > 0) {
      cues.push(...cuesFromWords(segment.words));
    } else {
      // No word timings: spread the words across the segment.
      const words = text.split(/\s+/);
      const step = (segment.end - segment.start) / words.length;
      cues.push(
        ...cuesFromWords(
          words.map((w, i) => ({
            w,
            start: segment.start + i * step,
            end: segment.start + (i + 1) * step,
            prob: 1,
          })),
        ),
      );
    }
  }
  // Keep cues in order, never overlapping, and long enough to read.
  return cues.map((cue, i) => {
    const next = cues[i + 1];
    let end = Math.max(cue.end, cue.start + MIN_CUE_SECONDS);
    if (next && end > next.start && next.start > cue.start) end = next.start;
    return { ...cue, end };
  });
}

export function toSrt(segments: Segment[]): string {
  return buildCues(segments)
    .map(
      (cue, i) =>
        `${i + 1}\n${formatTimestamp(cue.start, ',')} --> ${formatTimestamp(cue.end, ',')}\n${wrapLines(cue.text)}\n`,
    )
    .join('\n');
}

export function toVtt(segments: Segment[]): string {
  const body = buildCues(segments)
    .map(
      (cue) =>
        `${formatTimestamp(cue.start, '.')} --> ${formatTimestamp(cue.end, '.')}\n${wrapLines(cue.text)}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** Plain text, one paragraph per stretch of speech, with a new paragraph after a pause. */
export function toText(segments: Segment[], pauseSeconds = 1.5): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let previousEnd: number | null = null;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    if (previousEnd !== null && segment.start - previousEnd >= pauseSeconds && current.length) {
      paragraphs.push(current.join(' '));
      current = [];
    }
    current.push(text);
    previousEnd = segment.end;
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.join('\n\n') + (paragraphs.length ? '\n' : '');
}

export const TRANSCRIPT_FORMATS = {
  srt: { render: toSrt, contentType: 'application/x-subrip; charset=utf-8' },
  vtt: { render: toVtt, contentType: 'text/vtt; charset=utf-8' },
  txt: { render: toText, contentType: 'text/plain; charset=utf-8' },
} as const;
export type TranscriptFormat = keyof typeof TRANSCRIPT_FORMATS;
