export const JOB_TYPES = ['clean', 'transcribe'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** The sermon status a failed job leaves behind, so a retry knows where to resume. */
export const FAILED_STAGES = ['cleaning', 'transcribing', 'analyzing'] as const;
export type FailedStage = (typeof FAILED_STAGES)[number];

export const STAGE_JOB: Record<FailedStage, JobType | null> = {
  cleaning: 'clean',
  transcribing: 'transcribe',
  // Analysis arrives in Phase 3.
  analyzing: null,
};
