import { formatClock, formatRecordedOn } from '@/lib/format';
import { formatReference, type Reference } from '@/lib/scripture/canon';

/**
 * Titles and show notes for YouTube and the podcast feed (SPEC §8: the summary, the scripture list
 * with timestamps, and the transcript). Pure functions, so the publish dialog's preview is exactly
 * what gets sent.
 */
export type NotesInput = {
  title: string;
  recordedOn: string | null;
  speaker: string | null;
  churchName: string;
  summary: string | null;
  passages: { ref: Reference; spokenAtSec: number | null; isMainText: boolean }[];
  transcriptText: string | null;
};

/** YouTube's limits: 100 characters of title, 5,000 bytes of description, no angle brackets. */
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
/** The most transcript a YouTube description carries, even when there is room for more. */
const EXCERPT_MAX = 2500;

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** YouTube rejects `<` and `>` in titles and descriptions. */
const youtubeSafe = (text: string) => text.replace(/[<>]/g, '');

/** Cuts text at a word boundary so it fits, ending with an ellipsis. */
export function clip(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const words = text.split(/(\s+)/);
  let out = '';
  for (const word of words) {
    const next = out + word;
    if (!fits(`${next.trimEnd()}…`)) break;
    out = next;
  }
  out = out.trimEnd();
  return out ? `${out}…` : '';
}

/** "Recorded Mar 13, 1988. John Smith. Grace Church." Skips what is unknown. */
export function byline(input: NotesInput): string {
  const date = formatRecordedOn(input.recordedOn);
  return [date ? `Recorded ${date}` : null, input.speaker?.trim() || null, input.churchName]
    .filter(Boolean)
    .map((part) => `${part}.`)
    .join(' ');
}

/** "Hebrews 13:17 (main text), at 12:34". */
export function passageLines(input: NotesInput): string[] {
  return input.passages.map((p) => {
    const name = formatReference(p.ref) + (p.isMainText ? ' (main text)' : '');
    return p.spokenAtSec === null ? name : `${name}, at ${formatClock(p.spokenAtSec)}`;
  });
}

export function youtubeTitle(input: NotesInput): string {
  const title = youtubeSafe(input.title).replace(/\s+/g, ' ').trim() || 'Sermon';
  return clip(title, (t) => t.length <= YOUTUBE_TITLE_MAX);
}

/** Summary, passages with timestamps, byline, then as much transcript as fits. */
export function youtubeDescription(input: NotesInput): string {
  const sections: string[] = [];
  if (input.summary?.trim()) sections.push(input.summary.trim());
  const passages = passageLines(input);
  if (passages.length) sections.push(['Scripture', ...passages].join('\n'));
  sections.push(byline(input));
  const head = youtubeSafe(sections.join('\n\n'));
  const fitsHead = clip(head, (t) => bytes(t) <= YOUTUBE_DESCRIPTION_MAX_BYTES);
  const transcript = youtubeSafe(input.transcriptText?.trim() ?? '');
  if (!transcript || fitsHead !== head) return fitsHead;

  const label = '\n\nFrom the transcript\n';
  const room = YOUTUBE_DESCRIPTION_MAX_BYTES - bytes(head) - bytes(label);
  const excerpt = clip(transcript, (t) => t.length <= EXCERPT_MAX && bytes(t) <= room);
  return excerpt ? `${head}${label}${excerpt}` : head;
}

/** Podcast show notes as plain text: summary, passages and byline. The transcript is linked. */
export function podcastNotesText(input: NotesInput): string {
  const sections: string[] = [];
  if (input.summary?.trim()) sections.push(input.summary.trim());
  const passages = passageLines(input);
  if (passages.length) sections.push(['Scripture:', ...passages.map((p) => `- ${p}`)].join('\n'));
  sections.push(byline(input));
  return sections.join('\n\n');
}

export const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The same notes as simple HTML, which podcast apps show with paragraphs and a list. */
export function podcastNotesHtml(input: NotesInput): string {
  const parts: string[] = [];
  if (input.summary?.trim()) {
    for (const paragraph of input.summary.trim().split(/\n\s*\n/)) {
      parts.push(`<p>${escapeHtml(paragraph.trim())}</p>`);
    }
  }
  const passages = passageLines(input);
  if (passages.length) {
    parts.push('<p>Scripture:</p>');
    parts.push(`<ul>${passages.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`);
  }
  parts.push(`<p>${escapeHtml(byline(input))}</p>`);
  return parts.join('');
}
