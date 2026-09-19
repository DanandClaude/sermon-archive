/** Pipeline states from SPEC §4. `published` lives in `publications`, not here. */
export const SERMON_STATUSES = [
  'uploading',
  'uploaded',
  'cleaning',
  'transcribing',
  'analyzing',
  'needs_review',
  'approved',
  'filing',
  'filed',
  'failed',
] as const;
export type SermonStatus = (typeof SERMON_STATUSES)[number];

const APPROVED_OR_LATER: ReadonlySet<SermonStatus> = new Set(['approved', 'filing', 'filed']);

/** True once a human has approved the sermon. A failed filing keeps status `approved` (SPEC §7). */
export function isApprovedOrLater(status: SermonStatus): boolean {
  return APPROVED_OR_LATER.has(status);
}

/**
 * Allowed status changes. A filing failure keeps the sermon `approved` with a visible error
 * (SPEC §7), so `filing` can go back to `approved`. A failed stage is retried by moving
 * `failed` back to that stage. A failed upload is aborted rather than retried here.
 */
export const TRANSITIONS: Record<SermonStatus, readonly SermonStatus[]> = {
  uploading: ['uploaded', 'failed'],
  uploaded: ['cleaning', 'failed'],
  cleaning: ['transcribing', 'failed'],
  transcribing: ['analyzing', 'failed'],
  analyzing: ['needs_review', 'failed'],
  // Back to analyzing when a reviewer asks for the summary to be regenerated.
  needs_review: ['approved', 'analyzing'],
  approved: ['filing'],
  filing: ['filed', 'approved'],
  filed: [],
  failed: ['cleaning', 'transcribing', 'analyzing'],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SermonStatus,
    readonly to: SermonStatus,
  ) {
    super(`A sermon cannot go from "${from}" to "${to}".`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: SermonStatus, to: SermonStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SermonStatus, to: SermonStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
