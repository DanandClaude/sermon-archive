import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAILED_STAGES, JOB_TYPES, STAGE_JOB } from './job-types';
import { SERMON_STATUSES, TRANSITIONS } from './sermon-status';

const read = (file: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'shared', file), 'utf8'));
const pipeline = read('pipeline.json');

// shared/pipeline.json is what the Python worker reads. If these fail, the app and the worker
// disagree about what a sermon is allowed to do.
describe('shared/pipeline.json matches the TypeScript definitions', () => {
  it('lists the same statuses in the same order', () => {
    expect(pipeline.statuses).toEqual([...SERMON_STATUSES]);
  });

  it('allows exactly the same transitions', () => {
    expect(pipeline.transitions).toEqual(TRANSITIONS);
  });

  it('has a job config for each job type, and no others', () => {
    expect(Object.keys(pipeline.jobs).sort()).toEqual([...JOB_TYPES].sort());
  });

  it('starts each job from statuses that are allowed to lead into it', () => {
    for (const [type, cfg] of Object.entries<{ runningStatus: string; startFrom: string[] }>(
      pipeline.jobs,
    )) {
      for (const from of cfg.startFrom) {
        expect(
          from === cfg.runningStatus ||
            TRANSITIONS[from as keyof typeof TRANSITIONS].includes(cfg.runningStatus as never),
          `${type} from ${from}`,
        ).toBe(true);
      }
    }
  });

  it('hands each finished job to a legal next status', () => {
    for (const cfg of Object.values<{ runningStatus: string; onSuccess: { status: string } }>(
      pipeline.jobs,
    )) {
      expect(TRANSITIONS[cfg.runningStatus as keyof typeof TRANSITIONS]).toContain(
        cfg.onSuccess.status,
      );
    }
  });

  it('lists the failed stages, each of which can be reached from failed', () => {
    expect(pipeline.failedStages).toEqual([...FAILED_STAGES]);
    for (const stage of FAILED_STAGES) expect(TRANSITIONS.failed).toContain(stage);
  });

  it('maps every failed stage to a job type that runs in that stage, or none yet', () => {
    for (const stage of FAILED_STAGES) {
      const job = STAGE_JOB[stage];
      if (job) expect(pipeline.jobs[job].runningStatus).toBe(stage);
    }
  });
});

describe('shared/bible-books.json', () => {
  const books = read('bible-books.json');
  it('has the 66-book Protestant canon', () => {
    expect(books.oldTestament).toHaveLength(39);
    expect(books.newTestament).toHaveLength(27);
  });
  it('has no duplicates', () => {
    const all = [...books.oldTestament, ...books.newTestament];
    expect(new Set(all).size).toBe(66);
  });
});
