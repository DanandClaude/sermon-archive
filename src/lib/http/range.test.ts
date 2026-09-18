import { describe, expect, it } from 'vitest';
import { parseRange } from './range';

describe('parseRange', () => {
  it('means the whole file when there is no header', () => {
    expect(parseRange(null, 1000)).toBeNull();
  });
  it.each([
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=500-', { start: 500, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=900-5000', { start: 900, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
  ])('%s', (header, range) => expect(parseRange(header, 1000)).toEqual(range));
  it.each([
    'bytes=1000-',
    'bytes=50-10',
    'bytes=-',
    'bytes=-0',
    'items=0-5',
    'bytes=0-5,10-20',
    'garbage',
  ])('rejects %s', (header) => expect(parseRange(header, 1000)).toBe('invalid'));
});
