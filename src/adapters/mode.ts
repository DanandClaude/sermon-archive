import type { Env } from '@/lib/env';

export type AdapterMode = 'fake' | 'real';

export class RealAdapterBlockedError extends Error {
  constructor() {
    super(
      'ADAPTER_MODE=real is only allowed when NODE_ENV=production. Development and tests use fake ' +
        'adapters so nothing is ever filed or published to a real account.',
    );
    this.name = 'RealAdapterBlockedError';
  }
}

/** Fails loudly instead of quietly falling back, so a misconfigured env is noticed. */
export function resolveAdapterMode(env: Pick<Env, 'NODE_ENV' | 'ADAPTER_MODE'>): AdapterMode {
  if (env.ADAPTER_MODE === 'real' && env.NODE_ENV !== 'production') {
    throw new RealAdapterBlockedError();
  }
  return env.ADAPTER_MODE;
}
