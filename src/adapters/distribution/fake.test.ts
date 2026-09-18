import { describe, expect, it } from 'vitest';
import { runDistributionChannelContract, sampleInput } from '../../../tests/contracts/distribution';
import { FakeDistributionChannel } from './fake';
import { UnsupportedVisibilityError } from './types';

runDistributionChannelContract('fake YouTube', () => new FakeDistributionChannel('youtube'));
runDistributionChannelContract('fake podcast', () => new FakeDistributionChannel('podcast'));

describe('FakeDistributionChannel', () => {
  it('allows unlisted on YouTube', async () => {
    const result = await new FakeDistributionChannel('youtube').publish({
      ...sampleInput,
      visibility: 'unlisted',
    });
    expect(result.remoteUrl).toContain('/youtube/');
  });

  it('rejects unlisted on a podcast feed, which has no such thing', async () => {
    await expect(
      new FakeDistributionChannel('podcast').publish({ ...sampleInput, visibility: 'unlisted' }),
    ).rejects.toBeInstanceOf(UnsupportedVisibilityError);
  });
});
