// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewProvider } from './ReviewContext';
import { SermonPlayer } from './SermonPlayer';

const peaks = { duration: 100, peaks: [0.1, 0.5, 0.9] };

const setup = () =>
  render(
    <ReviewProvider sermonId="s1">
      <SermonPlayer cleanedUrl="/media/cleaned.mp3" cleanedPeaks={peaks} durationSec={100} />
    </ReviewProvider>,
  );
const audio = () => document.querySelector('audio')!;

describe('SermonPlayer', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  it('plays the cleaned recording and offers no choice of version', () => {
    setup();
    expect(audio().getAttribute('src')).toBe('/media/cleaned.mp3');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText(/original tape/i)).toBeNull();
  });

  it('shows one waveform, the length, and the transport controls', () => {
    setup();
    expect(screen.getAllByRole('slider')).toHaveLength(1);
    expect(screen.getByText('/ 1:40')).toBeTruthy();
    for (const name of [/^play$/i, /back 15/i, /forward 15/i, /playback speed/i]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('cycles the speed', () => {
    setup();
    const speed = () => screen.getByRole('button', { name: /playback speed/i });
    fireEvent.click(speed());
    expect(speed().textContent).toBe('1.25×');
    expect(audio().playbackRate).toBe(1.25);
  });

  it('explains it when the browser cannot play the file', () => {
    setup();
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => void fireEvent.error(audio()));
    expect(screen.getByRole('alert').textContent).toMatch(/can’t play this recording/);
  });
});
