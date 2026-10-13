import { and, count, desc, eq, gte, inArray, sql, sum } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { audioAssets, distributionChannels, jobs, publications, sermons } from '@/db/schema';
import { readYouTubeSettings } from '@/lib/distribution/channels';
import { getWorkerStatus, type WorkerStatus } from '@/lib/jobs';
import { assertCan, type Actor } from '@/lib/permissions';
import { getBackupState, type BackupState } from '@/lib/storage/backup-status';
import { listTargets } from '@/lib/storage/connections';
import { listProblems } from '@/lib/storage/filing';

export type Tone = 'ok' | 'warn' | 'bad';

export type FailedJob = {
  id: string;
  sermonId: string;
  sermonTitle: string | null;
  type: string;
  error: string | null;
  at: Date | null;
};

export type SystemHealth = {
  worker: WorkerStatus;
  queue: { waiting: number; running: number; failedThisWeek: number; recentFailures: FailedJob[] };
  backup: BackupState;
  filing: { connected: number; problems: number };
  publishing: {
    failed: number;
    waiting: number;
    youtubeToday: number;
    youtubeCap: number | null;
  };
  storage: { originals: number; cleaned: number; videos: number };
  /** Plain-language problems, worst first. Empty when everything is working. */
  attention: { tone: Tone; text: string; href: string }[];
};

const DAY = 86_400_000;

/**
 * One look at whether the archive is working: the worker, the queue, backups, filing, publishing
 * and storage. Admins only, because it shows raw job errors (SPEC: those stay with admins).
 */
export async function getSystemHealth(
  db: Db,
  actor: Actor,
  now = new Date(),
): Promise<SystemHealth> {
  assertCan(actor.role, 'settings.manage');
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const dayAgo = new Date(now.getTime() - DAY);

  const [worker, backup, targets, problems] = await Promise.all([
    getWorkerStatus(db, now),
    getBackupState(db, actor, now),
    listTargets(db, actor),
    listProblems(db, actor),
  ]);

  const [jobCounts] = await db
    .select({
      waiting: sql<number>`count(*) filter (where ${jobs.state} = 'queued')::int`,
      running: sql<number>`count(*) filter (where ${jobs.state} = 'running')::int`,
      failedThisWeek: sql<number>`count(*) filter (where ${jobs.state} = 'failed' and ${gte(jobs.finishedAt, weekAgo)})::int`,
    })
    .from(jobs);
  const recentFailures = await db
    .select({
      id: jobs.id,
      sermonId: jobs.sermonId,
      sermonTitle: sermons.title,
      type: jobs.type,
      error: jobs.lastError,
      at: jobs.finishedAt,
    })
    .from(jobs)
    .innerJoin(sermons, eq(sermons.id, jobs.sermonId))
    .where(and(eq(jobs.state, 'failed'), gte(jobs.finishedAt, weekAgo)))
    .orderBy(desc(jobs.finishedAt))
    .limit(10);

  const [pubCounts] = await db
    .select({
      failed: sql<number>`count(*) filter (where ${publications.state} = 'failed')::int`,
      waiting: sql<number>`count(*) filter (where ${publications.state} in ('queued', 'publishing', 'removing'))::int`,
      youtubeToday: sql<number>`count(*) filter (where ${distributionChannels.kind} = 'youtube' and ${gte(publications.uploadedAt, dayAgo)})::int`,
    })
    .from(publications)
    .innerJoin(distributionChannels, eq(distributionChannels.id, publications.channelId));
  const [youtube] = await db
    .select()
    .from(distributionChannels)
    .where(eq(distributionChannels.kind, 'youtube'));
  const youtubeCap =
    youtube && youtube.disconnectedAt === null && youtube.connectedAt
      ? readYouTubeSettings(youtube.settings).dailyUploads
      : null;

  const sizes = await db
    .select({ kind: audioAssets.kind, bytes: sum(audioAssets.bytes).mapWith(Number), n: count() })
    .from(audioAssets)
    .where(inArray(audioAssets.kind, ['original', 'cleaned', 'video_render']))
    .groupBy(audioAssets.kind);
  const bytes = (kind: string) => sizes.find((s) => s.kind === kind)?.bytes ?? 0;

  const connected = targets.filter((t) => t.connected).length;
  const attention: SystemHealth['attention'] = [];
  if (!worker.online)
    attention.push({
      tone: 'bad',
      text: worker.lastSeenAt
        ? 'The processing worker has stopped. Uploads wait until it is started again.'
        : 'The processing worker has never run. Start it so uploads get processed.',
      href: '#worker',
    });
  if (backup.kind === 'failed' || backup.kind === 'stale')
    attention.push({
      tone: 'bad',
      text:
        backup.kind === 'failed'
          ? 'The last database backup failed.'
          : 'No database backup in the last day and a half.',
      href: '/admin/connections#backup-h',
    });
  if (connected < 2)
    attention.push({
      tone: 'warn',
      text: 'Connect both drives so approved sermons can be filed.',
      href: '/admin/connections',
    });
  if (problems.length)
    attention.push({
      tone: 'bad',
      text: `${problems.length} filed ${problems.length === 1 ? 'file has' : 'files have'} changed or gone missing.`,
      href: '/admin/connections#problems-h',
    });
  if (jobCounts.failedThisWeek)
    attention.push({
      tone: 'warn',
      text: `${jobCounts.failedThisWeek} processing ${jobCounts.failedThisWeek === 1 ? 'step' : 'steps'} failed this week.`,
      href: '#failures',
    });
  if (pubCounts.failed)
    attention.push({
      tone: 'warn',
      text: `${pubCounts.failed} ${pubCounts.failed === 1 ? 'publication' : 'publications'} failed.`,
      href: '/admin/publishing',
    });
  attention.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1));

  return {
    worker,
    queue: { ...jobCounts, recentFailures },
    backup,
    filing: { connected, problems: problems.length },
    publishing: { ...pubCounts, youtubeCap },
    storage: {
      originals: bytes('original'),
      cleaned: bytes('cleaned'),
      videos: bytes('video_render'),
    },
    attention,
  };
}
