export type ChannelKind = 'youtube' | 'podcast';

/** Podcast feeds have no true "unlisted" (SPEC §8): publishing makes the audio public. */
export type Visibility = 'draft' | 'unlisted' | 'public';

export type PublishInput = {
  sermonId: string;
  title: string;
  /** Summary, scripture list with timestamps and transcript excerpt (SPEC §8). */
  description: string;
  visibility: Visibility;
  audioPath: string;
  captionsPath?: string;
};

export type PublishResult = { remoteId: string; remoteUrl: string };

/**
 * A place an admin can publish an approved sermon. Deliberately minimal; Phase 5 will refine
 * it against the real YouTube and podcast requirements. Only admin-initiated code may call it.
 */
export interface DistributionChannel {
  readonly kind: ChannelKind;
  publish(input: PublishInput): Promise<PublishResult>;
  /** Idempotent: unpublishing something already gone is not an error. */
  unpublish(remoteId: string): Promise<void>;
}

export class UnsupportedVisibilityError extends Error {
  constructor(kind: ChannelKind, visibility: Visibility) {
    super(`${kind} does not support "${visibility}" visibility`);
    this.name = 'UnsupportedVisibilityError';
  }
}
