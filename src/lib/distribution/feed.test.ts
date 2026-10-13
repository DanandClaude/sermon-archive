import { describe, expect, it } from 'vitest';
import { buildFeed, podcastSettingsSchema, xmlEscape, type FeedEpisode } from './feed';

const show = {
  title: 'Grace Church Sermons',
  author: 'Grace Church',
  description: 'Sermons from the tape archive.',
  ownerEmail: 'office@example.org',
  language: 'en-US',
};
const episode = (over: Partial<FeedEpisode> = {}): FeedEpisode => ({
  guid: 'pub-1',
  title: 'Submitting to Leaders',
  notesText: 'Notes',
  notesHtml: '<p>Notes</p>',
  pubDate: new Date('2026-10-01T12:00:00Z'),
  audioUrl: 'https://a.test/podcast/episodes/pub-1.mp3',
  bytes: 1234,
  durationSec: 1800.4,
  transcriptUrl: 'https://a.test/podcast/episodes/pub-1.srt',
  ...over,
});
const feed = (
  episodes: FeedEpisode[],
  artworkUrl: string | null = 'https://a.test/podcast/artwork.png',
) =>
  buildFeed({
    show,
    siteUrl: 'https://a.test',
    feedUrl: 'https://a.test/podcast/feed.xml',
    artworkUrl,
    episodes,
    builtAt: new Date('2026-10-02T00:00:00Z'),
  });

describe('buildFeed', () => {
  it('writes the show details Apple and Spotify read', () => {
    const xml = feed([]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<language>en-us</language>');
    expect(xml).toContain('<itunes:email>office@example.org</itunes:email>');
    expect(xml).toContain('<itunes:image href="https://a.test/podcast/artwork.png"/>');
    expect(xml).toContain(
      '<itunes:category text="Religion &amp; Spirituality"><itunes:category text="Christianity"/>',
    );
    expect(xml).toContain('<atom:link href="https://a.test/podcast/feed.xml" rel="self"');
  });

  it('leaves out the owner and image when there are none', () => {
    const xml = buildFeed({
      show: { ...show, ownerEmail: '' },
      siteUrl: 'https://a.test',
      feedUrl: 'https://a.test/podcast/feed.xml',
      artworkUrl: null,
      episodes: [],
      builtAt: new Date(),
    });
    expect(xml).not.toContain('itunes:owner');
    expect(xml).not.toContain('itunes:image');
  });

  it('lists episodes newest first with audio, duration and transcript', () => {
    const xml = feed([
      episode(),
      episode({ guid: 'pub-2', title: 'Later', pubDate: new Date('2026-10-05T12:00:00Z') }),
    ]);
    expect(xml.indexOf('pub-2')).toBeLessThan(xml.indexOf('pub-1'));
    expect(xml).toContain(
      '<enclosure url="https://a.test/podcast/episodes/pub-1.mp3" length="1234" type="audio/mpeg"/>',
    );
    expect(xml).toContain('<itunes:duration>1800</itunes:duration>');
    expect(xml).toContain(
      '<podcast:transcript url="https://a.test/podcast/episodes/pub-1.srt" type="application/x-subrip"',
    );
    expect(xml).toContain('<pubDate>Thu, 01 Oct 2026 12:00:00 GMT</pubDate>');
  });

  it('escapes text so a title cannot break the XML', () => {
    const xml = feed([
      episode({ title: 'Faith & <Works>', notesHtml: '<p>x</p>', transcriptUrl: null }),
    ]);
    expect(xml).toContain('<title>Faith &amp; &lt;Works&gt;</title>');
    expect(xml).toContain('<content:encoded>&lt;p&gt;x&lt;/p&gt;</content:encoded>');
    expect(xml).not.toContain('podcast:transcript url');
  });
});

describe('xmlEscape', () => {
  it('drops characters XML does not allow', () => {
    expect(xmlEscape('a\u0000b\u0007c\td')).toBe('abc\td');
  });
});

describe('podcastSettingsSchema', () => {
  it('accepts a blank owner email and refuses bad values', () => {
    expect(podcastSettingsSchema.safeParse({ ...show, ownerEmail: '' }).success).toBe(true);
    for (const bad of [{ title: ' ' }, { ownerEmail: 'nope' }, { language: 'english' }]) {
      expect(podcastSettingsSchema.safeParse({ ...show, ...bad }).success).toBe(false);
    }
  });
});
