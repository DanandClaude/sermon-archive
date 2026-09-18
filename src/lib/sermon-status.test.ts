import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sermons } from '@/db/schema';
import { insertUser, openTestDb, resetTables } from '../../tests/support/db';
import { transitionSermon } from './sermons/transition';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isApprovedOrLater,
  SERMON_STATUSES,
  TRANSITIONS,
  type SermonStatus,
} from './sermon-status';

describe('sermon state machine', () => {
  it('allows exactly the transitions in the table, for every pair of states', () => {
    for (const from of SERMON_STATUSES) {
      for (const to of SERMON_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(TRANSITIONS[from].includes(to));
      }
    }
  });

  it('never moves a sermon to the state it is already in', () => {
    for (const s of SERMON_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('follows the happy path from upload to filed', () => {
    const path: SermonStatus[] = [
      'uploading',
      'uploaded',
      'cleaning',
      'transcribing',
      'analyzing',
      'needs_review',
      'approved',
      'filing',
      'filed',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('makes every state reachable from a new upload, and filed a dead end', () => {
    const seen = new Set<SermonStatus>(['uploading']);
    const queue: SermonStatus[] = ['uploading'];
    while (queue.length) {
      for (const next of TRANSITIONS[queue.shift()!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...SERMON_STATUSES].sort());
    expect(TRANSITIONS.filed).toEqual([]);
  });

  it('only reaches approved from needs_review, or back from a failed filing', () => {
    for (const from of SERMON_STATUSES) {
      expect(canTransition(from, 'approved')).toBe(from === 'needs_review' || from === 'filing');
    }
  });

  it('keeps a sermon approved when filing fails, and retries a failed stage by name', () => {
    expect(canTransition('filing', 'approved')).toBe(true);
    expect(canTransition('failed', 'transcribing')).toBe(true);
    expect(canTransition('failed', 'approved')).toBe(false);
    expect(canTransition('failed', 'filed')).toBe(false);
  });

  it('never skips a stage', () => {
    expect(canTransition('uploaded', 'transcribing')).toBe(false);
    expect(canTransition('cleaning', 'needs_review')).toBe(false);
    expect(canTransition('needs_review', 'filed')).toBe(false);
  });

  it('assertTransition throws InvalidTransitionError with both states', () => {
    expect(() => assertTransition('filed', 'uploading')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('uploading', 'uploaded')).not.toThrow();
  });

  it('treats approved, filing and filed as approved-or-later', () => {
    expect(SERMON_STATUSES.filter(isApprovedOrLater)).toEqual(['approved', 'filing', 'filed']);
  });
});

describe('transitionSermon (compare-and-set)', () => {
  const db = openTestDb();
  afterAll(() => db.close());
  beforeEach(() => resetTables(db));

  async function newSermon(status: SermonStatus) {
    const user = await insertUser(db, 'contributor');
    const [s] = await db.insert(sermons).values({ contributorId: user.id, status }).returning();
    return s;
  }

  it('moves a sermon when it is still in the expected state', async () => {
    const s = await newSermon('uploading');
    expect(await transitionSermon(db, s.id, 'uploading', 'uploaded')).toBe(true);
  });

  it('refuses when the sermon has already moved on', async () => {
    const s = await newSermon('cleaning');
    expect(await transitionSermon(db, s.id, 'uploaded', 'cleaning')).toBe(false);
  });

  it('throws for a move the state machine does not allow', async () => {
    const s = await newSermon('uploaded');
    await expect(transitionSermon(db, s.id, 'uploaded', 'filed')).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it('lets exactly one of several simultaneous attempts win', async () => {
    const s = await newSermon('uploaded');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => transitionSermon(db, s.id, 'uploaded', 'cleaning')),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
