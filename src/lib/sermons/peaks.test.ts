import { describe, expect, it } from 'vitest';
import { readPeaks } from './peaks';

const storeWith = (body: string | Error) => ({
  read: async () => {
    if (body instanceof Error) throw body;
    const bytes = new TextEncoder().encode(body);
    // Delivered in two chunks, as a real store might.
    return (async function* () {
      yield bytes.slice(0, 5);
      yield bytes.slice(5);
    })();
  },
});

describe('readPeaks', () => {
  it('reads the stored waveform', async () => {
    const stored = JSON.stringify({ version: 1, duration: 8.5, peaks: [0.1, 0.9] });
    expect(await readPeaks(storeWith(stored), 'peaks/a.json')).toEqual({
      duration: 8.5,
      peaks: [0.1, 0.9],
    });
  });

  it('returns null when there is no key', async () => {
    expect(await readPeaks(storeWith('{}'), null)).toBeNull();
  });

  it.each([
    ['not json', 'oops'],
    ['wrong shape', JSON.stringify({ duration: 'long', peaks: [] })],
    ['bad values', JSON.stringify({ duration: 1, peaks: ['a'] })],
    ['no peaks', JSON.stringify({ duration: 1 })],
  ])('returns null for %s', async (_name, body) => {
    expect(await readPeaks(storeWith(body), 'k')).toBeNull();
  });

  it('returns null when the file cannot be read', async () => {
    expect(await readPeaks(storeWith(new Error('gone')), 'k')).toBeNull();
  });
});
