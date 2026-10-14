export const CHANNEL_KINDS = ['youtube', 'podcast', 'library'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * One publication per sermon per channel (SPEC §8).
 * - `queued`: waiting for the worker to upload (YouTube) or to make it public again.
 * - `publishing`: the worker is on it.
 * - `published`: live on the channel.
 * - `failed`: gave up after retries; an admin can try again.
 * - `removing`: an admin asked to unpublish and the worker is on it (YouTube).
 * - `removed`: unpublished. The YouTube video is private; the podcast episode is out of the feed.
 *
 * Podcast episodes and the online library need no worker: the app serves both, so they go
 * straight to `published` and straight to `removed`.
 */
export const PUBLICATION_STATES = [
  'queued',
  'publishing',
  'published',
  'failed',
  'removing',
  'removed',
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

/**
 * YouTube's privacy settings. A podcast feed has no unlisted or private (SPEC §8), so its episodes
 * are always `public`, as is everything in the online library.
 */
export const VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Publishing rules (SPEC §8): start as unlisted on YouTube so an admin can look it over first. */
export const DEFAULT_YOUTUBE_VISIBILITY: Visibility = 'unlisted';

/** Video uploads cost most of the daily API quota, so a backlog is spread over several days. */
export const DEFAULT_DAILY_UPLOADS = 5;
export const MAX_DAILY_UPLOADS = 50;

export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  youtube: 'YouTube',
  podcast: 'Podcast feed',
  library: 'Online library',
};

export const isChannelKind = (value: unknown): value is ChannelKind =>
  (CHANNEL_KINDS as readonly unknown[]).includes(value);

/** Channels this app serves itself: no account, no worker, always public. */
export const isAppServed = (kind: ChannelKind) => kind === 'podcast' || kind === 'library';

export const isVisibility = (value: unknown): value is Visibility =>
  (VISIBILITIES as readonly unknown[]).includes(value);
