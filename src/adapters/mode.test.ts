import { describe, expect, it } from 'vitest';
import { RealAdapterBlockedError, resolveAdapterMode } from './mode';

describe('resolveAdapterMode', () => {
  it.each(['development', 'test', 'production'] as const)('allows fake in %s', (NODE_ENV) => {
    expect(resolveAdapterMode({ NODE_ENV, ADAPTER_MODE: 'fake' })).toBe('fake');
  });

  it.each(['development', 'test'] as const)('refuses real adapters in %s', (NODE_ENV) => {
    expect(() => resolveAdapterMode({ NODE_ENV, ADAPTER_MODE: 'real' })).toThrow(
      RealAdapterBlockedError,
    );
  });

  it('allows real adapters only in production', () => {
    expect(resolveAdapterMode({ NODE_ENV: 'production', ADAPTER_MODE: 'real' })).toBe('real');
  });
});
