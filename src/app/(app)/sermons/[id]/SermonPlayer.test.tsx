// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewProvider } from './ReviewContext';
import { SermonPlayer } from './SermonPlayer';

const peaks = { duration: 100, peaks: [0.1, 0.5, 0.9] };

function setup(over: Partial<React.ComponentProps<typeof SermonPlayer>> = {}) {
  return render(
    <ReviewProvider sermonId="s1">
      <SermonPlayer
        originalUrl="/media/original.mp3"
        cleanedUrl="/media/cleaned.mp3"
        originalPeaks={peaks}
        cleanedPeaks={peaks}
        durationSec={100}
        {...over}
      />
    </ReviewProvider>,
  );
}
const audio = () => document.querySelector('audio')!;
const radio = (name: RegExp) => screen.getByRole('radio', { name });

describe('SermonPlayer', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  it('starts on the cleaned version and switches to the original when it plays', () => {
    setup();
    expect(audio().getAttribute('src')).toBe('/media/cleaned.mp3');
    fireEvent.click(radio(/original/i));
    expect(audio().getAttribute('src')).toBe('/media/original.mp3');
    expect(radio(/original/i).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('when the browser cannot decode the original, says so and goes back to the cleaned version', () => {
    setup();
    fireEvent.click(radio(/original/i));
    act(() => void fireEvent.error(audio()));
    expect(audio().getAttribute('src')).toBe('/media/cleaned.mp3');
    expect(screen.getByRole('alert').textContent).toMatch(/can’t play the original tape file/);
    expect(screen.getByRole('alert').textContent).toMatch(/stored unchanged/);
    expect(radio(/original/i).hasAttribute('disabled')).toBe(true);
    expect(radio(/cleaned/i).getAttribute('aria-checked')).toBe('true');
  });

  it('does not offer the version that failed again', () => {
    setup();
    fireEvent.click(radio(/original/i));
    act(() => void fireEvent.error(audio()));
    fireEvent.click(radio(/original/i));
    expect(audio().getAttribute('src')).toBe('/media/cleaned.mp3');
  });

  it('with only the original available, explains that nothing can play instead of looping', () => {
    setup({ cleanedUrl: null });
    expect(audio().getAttribute('src')).toBe('/media/original.mp3');
    act(() => void fireEvent.error(audio()));
    expect(screen.getByRole('alert').textContent).toMatch(/can’t play the original tape file/);
    expect(audio().getAttribute('src')).toBe('/media/original.mp3');
  });

  it('says so when neither version plays', () => {
    setup();
    act(() => void fireEvent.error(audio())); // cleaned fails first: falls back to the original
    expect(audio().getAttribute('src')).toBe('/media/original.mp3');
    act(() => void fireEvent.error(audio()));
    expect(screen.getByRole('alert').textContent).toMatch(/can’t play either version/);
  });

  it('carries the listening position across to the version that works', () => {
    setup();
    fireEvent.click(radio(/original/i));
    act(() => void fireEvent.error(audio()));
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(0); // nothing had been played yet, so it starts at the top
  });
});
