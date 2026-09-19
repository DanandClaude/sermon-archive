import { describe, expect, it } from 'vitest';
import { downsample } from './Waveform';

describe('downsample', () => {
  it('keeps the loudest peak in each group', () => {
    expect(downsample([0.1, 0.9, 0.2, 0.3], 2)).toEqual([0.9, 0.3]);
  });
  it('spreads a short recording across all the bars', () => {
    expect(downsample([0.5, 1], 4)).toEqual([0.5, 0.5, 1, 1]);
  });
  it('gives no bars when there are no peaks', () => {
    expect(downsample([], 10)).toEqual([]);
  });
});
