// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewProvider } from './ReviewContext';
import { TranscriptPanel } from './TranscriptPanel';

const segments = [
  { start: 0, end: 3, text: 'Good morning church.', words: [] },
  { start: 65, end: 70, text: 'Turn to Hebrews six.', words: [] },
];

const setup = (lowConfidence: [number, number][] = []) =>
  render(
    <ReviewProvider sermonId="s1">
      <TranscriptPanel segments={segments} lowConfidence={lowConfidence} />
    </ReviewProvider>,
  );
const toggle = () => screen.getByRole('button', { name: /transcript/i });

describe('TranscriptPanel', () => {
  beforeEach(() => localStorage.clear());

  it('starts closed so the page is short, with the toggle announcing its state', () => {
    setup();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Good morning church.').closest('[hidden]')).not.toBeNull();
  });

  it('opens and closes with the button', () => {
    setup();
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Good morning church.').closest('[hidden]')).toBeNull();
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('remembers being open next time', () => {
    const first = setup();
    fireEvent.click(toggle());
    first.unmount();
    setup();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('still works when storage is blocked', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    try {
      setup();
      fireEvent.click(toggle());
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it('keeps the count of doubtful words visible while closed', () => {
    setup([[0, 1]]);
    expect(screen.getByText('1 word to check')).toBeTruthy();
  });
});
