import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { audioAssets, jobs, settings, sermons, workerHeartbeats } from '@/db/schema';
import { ForbiddenError } from '@/lib/errors';
import { insertUser, openTestDb, resetTables } from '../../tests/support/db';
import { connectTestYouTube } from './distribution/channels';
import { getSystemHealth } from './health';
import { connectLocalFolder } from './storage/connections';

const db = openTestDb();
afterAll(() => db.close());
beforeEach(() => resetTables(db));

const NOW = new Date('2026-10-13T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('getSystemHealth', () => {
  it('is for admins only, since it shows raw job errors', async () => {
    for (const role of ['contributor', 'viewer'] as const) {
      const u = await insertUser(db, role);
      await expect(getSystemHealth(db, u, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('lists what needs attention on a fresh install, worst first', async () => {
    const admin = await insertUser(db, 'admin');
    const h = await getSystemHealth(db, admin, NOW);
    expect(h.worker.online).toBe(false);
    expect(h.attention.map((a) => a.tone)).toEqual(['bad', 'warn']);
    expect(h.attention[0].text).toMatch(/never run/);
    expect(h.attention[1].text).toMatch(/Connect both drives/);
  });

  it('says everything is working when it is', async () => {
    const admin = await insertUser(db, 'admin');
    await db.insert(workerHeartbeats).values({ workerId: 'w1', lastSeenAt: ago(10_000) });
    await db.insert(settings).values({
      key: 'backup_last',
      value: { ok: true, at: ago(3_600_000).toISOString(), bytes: 1000, encrypted: true },
    });
    await connectLocalFolder(db, admin, 'shared', '/tmp/shared');
    await connectLocalFolder(db, admin, 'backup', '/tmp/backup');
    await connectTestYouTube(db, admin);
    const h = await getSystemHealth(db, admin, NOW);
    expect(h.attention).toEqual([]);
    expect(h.publishing).toMatchObject({ youtubeToday: 0, youtubeCap: 5 });
  });

  it('counts this week’s failed steps and adds up storage', async () => {
    const admin = await insertUser(db, 'admin');
    const [s] = await db
      .insert(sermons)
      .values({ contributorId: admin.id, status: 'failed', title: 'Broken tape' })
      .returning();
    await db.insert(jobs).values([
      {
        sermonId: s.id,
        type: 'transcribe',
        state: 'failed',
        lastError: 'ffmpeg: bad header',
        finishedAt: ago(3_600_000),
      },
      {
        sermonId: s.id,
        type: 'clean',
        state: 'failed',
        lastError: 'old',
        finishedAt: ago(10 * 86_400_000),
      },
    ]);
    const asset = (kind: 'original' | 'cleaned', bytes: number) => ({
      sermonId: s.id,
      kind,
      storageKey: `${kind}/${s.id}`,
      sha256: 'x',
      bytes,
      mime: 'audio/mpeg',
      originalFilename: 'a.mp3',
    });
    await db
      .insert(audioAssets)
      .values([asset('original', 2_000_000_000), asset('cleaned', 500_000_000)]);
    const h = await getSystemHealth(db, admin, NOW);
    expect(h.queue.failedThisWeek).toBe(1);
    expect(h.queue.recentFailures).toEqual([
      expect.objectContaining({
        sermonTitle: 'Broken tape',
        type: 'transcribe',
        error: 'ffmpeg: bad header',
      }),
    ]);
    expect(h.storage).toEqual({ originals: 2_000_000_000, cleaned: 500_000_000, videos: 0 });
    expect(h.attention.some((a) => /1 processing step failed/.test(a.text))).toBe(true);
  });
});
