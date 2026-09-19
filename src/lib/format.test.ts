import { describe, expect, it } from 'vitest';
import { formatClock, formatRecordedOn, parseClock } from './format';

describe('formatClock and parseClock', () => {
  it('write playback positions', () => {
    expect(formatClock(83)).toBe('1:23');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-4)).toBe('0:00');
  });

  it.each([
    ['83', 83],
    ['1:23', 83],
    ['20:58', 1258],
    ['1:02:05', 3725],
    [' 0:07 ', 7],
    ['1:23.5', 83.5],
    ['00:00', 0],
  ])('reads %s as %s seconds', (text, seconds) => expect(parseClock(text)).toBe(seconds));

  it.each(['', 'abc', '1:75', '1:2:3:4', '-5', '1::2', '12:60', '1,5'])('rejects %j', (text) =>
    expect(parseClock(text)).toBeNull(),
  );

  it('round-trips what formatClock writes', () => {
    for (const seconds of [0, 59, 60, 1258, 3599, 3600, 7325]) {
      expect(parseClock(formatClock(seconds))).toBe(seconds);
    }
  });
});

describe('formatRecordedOn', () => {
  it('writes a date without a time zone shifting the day', () => {
    expect(formatRecordedOn('1988-03-13')).toBe('Mar 13, 1988');
    expect(formatRecordedOn(null)).toBeNull();
    expect(formatRecordedOn('soon')).toBeNull();
  });
});
