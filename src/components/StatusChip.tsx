import { SERMON_STATUS_LABEL, statusTone } from '@/lib/sermons/status-display';
import type { SermonStatus } from '@/lib/sermon-status';

const TONE = {
  amber: 'bg-amber-tint text-amber-text',
  spruce: 'bg-spruce-tint text-spruce',
  danger: 'bg-[#f8e6e2] text-danger',
  neutral: 'bg-chip text-muted',
} as const;

export function StatusChip({ status }: { status: SermonStatus }) {
  return (
    <span
      className={`inline-flex h-[26px] items-center whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold ${TONE[statusTone(status)]}`}
    >
      {SERMON_STATUS_LABEL[status]}
    </span>
  );
}
