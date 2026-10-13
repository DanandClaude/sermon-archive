import { z } from 'zod';

/**
 * The podcast's own details, edited by an admin on the Connections page. Apple and Spotify read
 * these from the feed; the owner email is how they confirm who runs the podcast.
 */
export const podcastSettingsSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Give the podcast a name.')
    .max(120, 'Keep it under 120 characters.'),
  author: z
    .string()
    .trim()
    .min(1, 'Say who the podcast is by.')
    .max(120, 'Keep it under 120 characters.'),
  description: z
    .string()
    .trim()
    .min(1, 'Describe the podcast in a sentence or two.')
    .max(3000, 'Keep it under 3,000 characters.'),
  ownerEmail: z.union([z.literal(''), z.email('Enter an email address, or leave it blank.')]),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[a-z]{2})?$/i, 'Use a language code such as en-us.'),
});
export type PodcastSettings = z.infer<typeof podcastSettingsSchema>;

export const PODCAST_CATEGORY = { text: 'Religion & Spirituality', sub: 'Christianity' } as const;

export type FeedEpisode = {
  guid: string;
  title: string;
  notesText: string;
  notesHtml: string;
  pubDate: Date;
  audioUrl: string;
  bytes: number;
  durationSec: number | null;
  transcriptUrl: string | null;
};

export type FeedInput = {
  show: PodcastSettings;
  siteUrl: string;
  feedUrl: string;
  artworkUrl: string | null;
  episodes: FeedEpisode[];
  builtAt: Date;
};

// XML 1.0 forbids most control characters, even escaped.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function xmlEscape(text: string): string {
  return text
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RFC 822 dates, as RSS wants: "Sun, 13 Mar 1988 12:00:00 GMT". */
export const rfc822 = (date: Date) => date.toUTCString();

const el = (name: string, text: string) => `<${name}>${xmlEscape(text)}</${name}>`;

function episodeXml(e: FeedEpisode): string {
  const lines = [
    '<item>',
    el('title', e.title),
    `<guid isPermaLink="false">${xmlEscape(e.guid)}</guid>`,
    el('pubDate', rfc822(e.pubDate)),
    el('description', e.notesText),
    el('content:encoded', e.notesHtml),
    `<enclosure url="${xmlEscape(e.audioUrl)}" length="${e.bytes}" type="audio/mpeg"/>`,
    e.durationSec ? el('itunes:duration', String(Math.round(e.durationSec))) : null,
    el('itunes:episodeType', 'full'),
    el('itunes:explicit', 'false'),
    e.transcriptUrl
      ? `<podcast:transcript url="${xmlEscape(e.transcriptUrl)}" type="application/x-subrip" language="en" rel="captions"/>`
      : null,
    '</item>',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * RSS 2.0 with Apple's itunes tags and the Podcasting 2.0 transcript tag. Newest episode first.
 * Only what the caller passes is listed; deciding which episodes are public happens before this.
 */
export function buildFeed(input: FeedInput): string {
  const { show } = input;
  const episodes = [...input.episodes].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  const owner = show.ownerEmail
    ? `<itunes:owner>${el('itunes:name', show.author)}${el('itunes:email', show.ownerEmail)}</itunes:owner>`
    : null;
  const image = input.artworkUrl
    ? [
        `<itunes:image href="${xmlEscape(input.artworkUrl)}"/>`,
        `<image>${el('url', input.artworkUrl)}${el('title', show.title)}${el('link', input.siteUrl)}</image>`,
      ].join('\n')
    : null;
  const channel = [
    el('title', show.title),
    el('link', input.siteUrl),
    `<atom:link href="${xmlEscape(input.feedUrl)}" rel="self" type="application/rss+xml"/>`,
    el('language', show.language.toLowerCase()),
    el('description', show.description),
    el('itunes:summary', show.description),
    el('itunes:author', show.author),
    owner,
    image,
    `<itunes:category text="${xmlEscape(PODCAST_CATEGORY.text)}"><itunes:category text="${xmlEscape(PODCAST_CATEGORY.sub)}"/></itunes:category>`,
    el('itunes:explicit', 'false'),
    el('itunes:type', 'episodic'),
    el('lastBuildDate', rfc822(input.builtAt)),
    el('generator', 'Sermon Archive'),
    ...episodes.map(episodeXml),
  ].filter(Boolean);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    ...channel,
    '</channel>',
    '</rss>',
    '',
  ].join('\n');
}
