import { describe, expect, it } from 'vitest';
import type { DistributionChannel, PublishInput } from '@/adapters/distribution/types';

export const sampleInput: PublishInput = {
  sermonId: 'sermon-1',
  title: 'Submitting to Leaders',
  description: 'A message on Hebrews 13:17.',
  visibility: 'draft',
  audioPath: '1980s/1988/1988-03-13_Hebrews-13-17_Submitting-to-Leaders.mp3',
};

/** Every DistributionChannel must pass this. Real adapters are only ever pointed at test accounts. */
export function runDistributionChannelContract(name: string, create: () => DistributionChannel) {
  describe(`DistributionChannel contract: ${name}`, () => {
    it('returns a remote id and URL for a published sermon', async () => {
      const result = await create().publish(sampleInput);
      expect(result.remoteId).toBeTruthy();
      expect(result.remoteUrl).toMatch(/^https?:\/\//);
    });

    it('gives each publication its own remote id', async () => {
      const channel = create();
      const a = await channel.publish(sampleInput);
      const b = await channel.publish({ ...sampleInput, sermonId: 'sermon-2' });
      expect(a.remoteId).not.toBe(b.remoteId);
    });

    it('unpublish is idempotent, including for an id that never existed', async () => {
      const channel = create();
      const { remoteId } = await channel.publish(sampleInput);
      await channel.unpublish(remoteId);
      await expect(channel.unpublish(remoteId)).resolves.toBeUndefined();
      await expect(channel.unpublish('never-existed')).resolves.toBeUndefined();
    });
  });
}
