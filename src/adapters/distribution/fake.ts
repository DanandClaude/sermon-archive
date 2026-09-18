import {
  UnsupportedVisibilityError,
  type ChannelKind,
  type DistributionChannel,
  type PublishInput,
  type PublishResult,
} from './types';

/** Records publications in memory and returns fake URLs. Never talks to a real account. */
export class FakeDistributionChannel implements DistributionChannel {
  private readonly published = new Map<string, PublishInput>();
  private counter = 0;

  constructor(readonly kind: ChannelKind) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    if (this.kind === 'podcast' && input.visibility === 'unlisted') {
      throw new UnsupportedVisibilityError(this.kind, input.visibility);
    }
    const remoteId = `fake-${this.kind}-${++this.counter}`;
    this.published.set(remoteId, input);
    return { remoteId, remoteUrl: `https://fake.example.test/${this.kind}/${remoteId}` };
  }

  async unpublish(remoteId: string): Promise<void> {
    this.published.delete(remoteId);
  }

  /** Test hook. */
  get(remoteId: string): PublishInput | undefined {
    return this.published.get(remoteId);
  }
}
