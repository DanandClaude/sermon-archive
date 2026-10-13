import { describe, expect, it } from 'vitest';
import { canRetry, canUnpublish, lockedPrivateNote, stateLabel } from './labels';
import { PUBLICATION_STATES } from './states';

const yt = { channel: 'youtube' as const, visibility: 'unlisted' as const, remoteVisibility: null };

describe('publication labels', () => {
  it('has a plain label for every state on both channels', () => {
    for (const state of PUBLICATION_STATES) {
      expect(stateLabel({ ...yt, state }).text).not.toBe('');
      expect(stateLabel({ ...yt, channel: 'podcast', state }).text).not.toBe('');
    }
  });

  it('reports the visibility YouTube actually applied', () => {
    const locked = { ...yt, state: 'published' as const, remoteVisibility: 'private' as const };
    expect(stateLabel(locked).text).toBe('Published, private');
    expect(lockedPrivateNote(locked)).toMatch(/kept this video private, although unlisted/);
    expect(lockedPrivateNote({ ...locked, remoteVisibility: 'unlisted' })).toBeNull();
    expect(lockedPrivateNote({ ...locked, visibility: 'private' })).toBeNull();
  });

  it('offers unpublish and retry only where they make sense', () => {
    expect(PUBLICATION_STATES.filter(canUnpublish)).toEqual(['queued', 'published', 'failed']);
    expect(PUBLICATION_STATES.filter(canRetry)).toEqual(['failed']);
  });
});
