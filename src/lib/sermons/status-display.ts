import type { SermonStatus } from '@/lib/sermon-status';

export const SERMON_STATUS_LABEL: Record<SermonStatus, string> = {
  uploading: 'Uploading',
  uploaded: 'Waiting to process',
  cleaning: 'Cleaning audio',
  transcribing: 'Transcribing',
  analyzing: 'Transcript ready',
  needs_review: 'Needs review',
  approved: 'Approved',
  filing: 'Filing',
  filed: 'Filed',
  failed: 'Needs attention',
};

/** Colour family for a status chip: amber for waiting on a person, spruce for done, red for trouble. */
export function statusTone(status: SermonStatus): 'amber' | 'spruce' | 'danger' | 'neutral' {
  if (status === 'needs_review') return 'amber';
  if (status === 'approved' || status === 'filing' || status === 'filed') return 'spruce';
  if (status === 'failed') return 'danger';
  return 'neutral';
}
