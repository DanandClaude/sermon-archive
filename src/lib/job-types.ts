export const JOB_TYPES = ['clean', 'transcribe', 'analyze', 'file'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** The sermon status a failed job leaves behind, so a retry knows where to resume. */
export const FAILED_STAGES = ['cleaning', 'transcribing', 'analyzing'] as const;
export type FailedStage = (typeof FAILED_STAGES)[number];

export const STAGE_JOB: Record<FailedStage, JobType | null> = {
  cleaning: 'clean',
  transcribing: 'transcribe',
  analyzing: 'analyze',
};

/**
 * Stages whose failure does not mark the sermon `failed`. A filing that fails leaves the sermon
 * `approved` with a visible error (SPEC §7), and an admin retries it.
 */
export const APPROVED_STAGE_JOBS = ['file'] as const satisfies readonly JobType[];
