import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './errors';

describe('isUniqueViolation', () => {
  it('sees the code on the error or on the error it wraps', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(
      isUniqueViolation(Object.assign(new Error('Failed query'), { cause: { code: '23505' } })),
    ).toBe(true);
  });
  it('is false for anything else', () => {
    for (const value of [
      null,
      undefined,
      new Error('x'),
      { code: '23503' },
      { cause: { code: '40001' } },
      'text',
    ])
      expect(isUniqueViolation(value)).toBe(false);
  });
});
