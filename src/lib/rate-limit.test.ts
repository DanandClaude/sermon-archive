import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit';

describe('RateLimiter', () => {
  it('allows up to the limit inside the window, then blocks', () => {
    const limiter = new RateLimiter(3, 1000);
    expect([1, 2, 3, 4].map(() => limiter.allow('a', 0))).toEqual([true, true, true, false]);
  });

  it('keeps separate counts per key', () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('b', 0)).toBe(true);
    expect(limiter.allow('a', 1)).toBe(false);
  });

  it('lets attempts through again once the window has passed', () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.allow('a', 0);
    expect(limiter.allow('a', 999)).toBe(false);
    expect(limiter.allow('a', 1000)).toBe(true);
  });

  it('does not count blocked attempts against the caller', () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.allow('a', 0);
    for (let t = 1; t < 500; t += 50) limiter.allow('a', t);
    expect(limiter.allow('a', 1000)).toBe(true);
  });
});
