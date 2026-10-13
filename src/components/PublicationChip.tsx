import { stateLabel, type Tone } from '@/lib/distribution/labels';
import type { ChannelKind, PublicationState, Visibility } from '@/lib/distribution/states';

const TONE: Record<Tone, string> = {
  ok: 'bg-spruce-tint text-spruce',
  busy: 'bg-amber-tint text-amber-text',
  warn: 'bg-amber-tint text-amber-text',
  bad: 'bg-[#f8e6e2] text-danger',
  none: 'bg-chip text-muted',
};

export function PublicationChip(props: {
  channel: ChannelKind;
  state: PublicationState;
  visibility: Visibility;
  remoteVisibility: Visibility | null;
}) {
  const { text, tone } = stateLabel(props);
  return (
    <span
      className={`inline-flex h-[26px] items-center whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold ${TONE[tone]}`}
    >
      {text}
    </span>
  );
}
