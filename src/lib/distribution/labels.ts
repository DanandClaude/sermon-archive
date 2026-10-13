import type { ChannelKind, PublicationState, Visibility } from './states';

type Labelled = {
  channel: ChannelKind;
  state: PublicationState;
  visibility: Visibility;
  remoteVisibility: Visibility | null;
};

export type Tone = 'ok' | 'busy' | 'warn' | 'bad' | 'none';

/** How a publication's state reads to an admin, in plain words. */
export function stateLabel(p: Labelled): { text: string; tone: Tone } {
  switch (p.state) {
    case 'queued':
      return { text: 'Waiting to upload', tone: 'busy' };
    case 'publishing':
      return { text: 'Uploading', tone: 'busy' };
    case 'published':
      return p.channel === 'podcast'
        ? { text: 'In the feed', tone: 'ok' }
        : p.channel === 'library'
          ? { text: 'In the library', tone: 'ok' }
          : { text: `Published, ${p.remoteVisibility ?? p.visibility}`, tone: 'ok' };
    case 'failed':
      return { text: 'Failed', tone: 'bad' };
    case 'removing':
      return { text: 'Making private', tone: 'busy' };
    case 'removed':
      return p.channel === 'podcast'
        ? { text: 'Removed from the feed', tone: 'none' }
        : p.channel === 'library'
          ? { text: 'Removed from the library', tone: 'none' }
          : { text: 'Unpublished (private)', tone: 'none' };
  }
}

/**
 * YouTube keeps videos from unaudited API projects private whatever was asked (see the install
 * guide). Says so when it happened, so "unlisted" is never reported for a private video.
 */
export function lockedPrivateNote(p: Labelled): string | null {
  if (p.channel !== 'youtube' || p.state !== 'published') return null;
  if (p.remoteVisibility !== 'private' || p.visibility === 'private') return null;
  return `YouTube kept this video private, although ${p.visibility} was chosen. This happens until Google approves the app's YouTube access; you can change it on YouTube in the meantime.`;
}

export const canUnpublish = (state: PublicationState) =>
  state === 'queued' || state === 'published' || state === 'failed';

export const canRetry = (state: PublicationState) => state === 'failed';
