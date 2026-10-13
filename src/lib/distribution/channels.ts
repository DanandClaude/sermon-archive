import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { auditLog, distributionChannels, publications } from '@/db/schema';
import { assertCan, type Actor } from '@/lib/permissions';
import { encryptJson } from '@/lib/secrets';
import type { AppSettings } from '@/lib/settings';
import { podcastSettingsSchema, type PodcastSettings } from './feed';
import {
  CHANNEL_KINDS,
  DEFAULT_DAILY_UPLOADS,
  DEFAULT_YOUTUBE_VISIBILITY,
  MAX_DAILY_UPLOADS,
  VISIBILITIES,
  type ChannelKind,
  type PublicationState,
  type Visibility,
} from './states';

export type DistributionErrorCode = 'invalid' | 'conflict' | 'not_found' | 'confirm';

/** A publishing action that could not be done, with a message fit to show an admin. */
export class DistributionError extends Error {
  constructor(
    readonly code: DistributionErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'DistributionError';
  }
}

export const youtubeSettingsSchema = z.object({
  defaultVisibility: z.enum(VISIBILITIES).default(DEFAULT_YOUTUBE_VISIBILITY),
  dailyUploads: z.coerce
    .number()
    .int('Use a whole number.')
    .min(1, 'Allow at least one upload a day.')
    .max(MAX_DAILY_UPLOADS, `At most ${MAX_DAILY_UPLOADS} a day.`)
    .default(DEFAULT_DAILY_UPLOADS),
});
export type YouTubeSettings = z.infer<typeof youtubeSettingsSchema>;

export function readYouTubeSettings(value: unknown): YouTubeSettings {
  const parsed = youtubeSettingsSchema.safeParse(value ?? {});
  return parsed.success
    ? parsed.data
    : { defaultVisibility: DEFAULT_YOUTUBE_VISIBILITY, dailyUploads: DEFAULT_DAILY_UPLOADS };
}

/** What a new podcast starts with, from the church profile. The admin can change all of it. */
export function podcastDefaults(profile: AppSettings): PodcastSettings {
  return {
    title: `${profile.churchName} Sermons`,
    author: profile.defaultSpeaker.trim() || profile.churchName,
    description: `Sermons from ${profile.churchName}, digitized from the church's cassette tapes.`,
    ownerEmail: '',
    language: 'en-us',
  };
}

export function readPodcastSettings(value: unknown, profile: AppSettings): PodcastSettings {
  const parsed = podcastSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : podcastDefaults(profile);
}

/** The online library's name and welcome line, edited on the Connections page. */
export const librarySettingsSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Give the library a name.')
    .max(120, 'Keep it under 120 characters.'),
  description: z.string().trim().max(600, 'Keep it under 600 characters.').default(''),
});
export type LibrarySettings = z.infer<typeof librarySettingsSchema>;

export function libraryDefaults(profile: AppSettings): LibrarySettings {
  return {
    title: `${profile.churchName} Sermons`,
    description: `Listen to sermons from ${profile.churchName}, digitized from the church's cassette tapes.`,
  };
}

export function readLibrarySettings(value: unknown, profile: AppSettings): LibrarySettings {
  const parsed = librarySettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : libraryDefaults(profile);
}

export type ChannelStatus = {
  kind: ChannelKind;
  connected: boolean;
  provider: string | null;
  accountLabel: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  youtube: YouTubeSettings | null;
  podcast: PodcastSettings | null;
  library: LibrarySettings | null;
  artworkReady: boolean;
  counts: Record<PublicationState, number>;
};

const emptyCounts = (): Record<PublicationState, number> => ({
  queued: 0,
  publishing: 0,
  published: 0,
  failed: 0,
  removing: 0,
  removed: 0,
});

export const isConnected = (row: { disconnectedAt: Date | null; connectedAt: Date | null }) =>
  row.connectedAt !== null && row.disconnectedAt === null;

/** Every channel as the Connections screen shows it. Never includes credentials. */
export async function listChannels(
  db: Db,
  actor: Actor,
  profile: AppSettings,
): Promise<ChannelStatus[]> {
  assertCan(actor.role, 'connections.manage');
  const rows = await db.select().from(distributionChannels);
  const counts = await db
    .select({ channelId: publications.channelId, state: publications.state, n: count() })
    .from(publications)
    .groupBy(publications.channelId, publications.state);
  return CHANNEL_KINDS.map((kind) => {
    const row = rows.find((r) => r.kind === kind);
    const tally = emptyCounts();
    for (const c of counts.filter((c) => c.channelId === row?.id)) tally[c.state] += c.n;
    return {
      kind,
      connected: !!row && isConnected(row),
      provider: row?.provider ?? null,
      accountLabel: row?.accountLabel ?? null,
      connectedAt: row?.connectedAt ?? null,
      disconnectedAt: row?.disconnectedAt ?? null,
      youtube: kind === 'youtube' ? readYouTubeSettings(row?.settings) : null,
      podcast: kind === 'podcast' ? readPodcastSettings(row?.settings, profile) : null,
      library: kind === 'library' ? readLibrarySettings(row?.settings, profile) : null,
      artworkReady: !!row?.artworkKey,
      counts: tally,
    };
  });
}

/** The channels an admin can publish to right now. */
export async function connectedChannels(
  db: Pick<Db, 'select'>,
): Promise<Map<ChannelKind, typeof distributionChannels.$inferSelect>> {
  const rows = await db.select().from(distributionChannels);
  return new Map(rows.filter(isConnected).map((r) => [r.kind, r]));
}

type Executor = Parameters<Parameters<Db['transaction']>[0]>[0];

async function upsertChannel(
  tx: Executor,
  kind: ChannelKind,
  values: Partial<typeof distributionChannels.$inferInsert> & { provider: string },
) {
  const [existing] = await tx
    .select()
    .from(distributionChannels)
    .where(eq(distributionChannels.kind, kind))
    .for('update');
  if (existing) {
    await tx
      .update(distributionChannels)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(distributionChannels.id, existing.id));
    return existing;
  }
  await tx.insert(distributionChannels).values({ kind, ...values });
  return null;
}

async function connectYouTubeAccount(
  db: Db,
  actor: Actor,
  input: { provider: 'youtube' | 'fake'; config: Record<string, unknown>; accountLabel: string },
) {
  assertCan(actor.role, 'connections.manage');
  const label = input.accountLabel.trim();
  if (!label) throw new DistributionError('invalid', 'The account could not be identified.');
  await db.transaction(async (tx) => {
    const existing = await upsertChannel(tx, 'youtube', {
      provider: input.provider,
      encryptedConfig: encryptJson({ ...input.config, kind: input.provider }),
      accountLabel: label,
      connectedBy: actor.id,
      connectedAt: new Date(),
      disconnectedAt: null,
    });
    if (existing && existing.accountLabel?.toLowerCase() !== label.toLowerCase()) {
      // Videos already uploaded belong to the old account; a different account can't change them.
      const [uploaded] = await tx
        .select({ n: count() })
        .from(publications)
        .where(eq(publications.channelId, existing.id));
      if (uploaded.n > 0) {
        throw new DistributionError(
          'conflict',
          `${existing.accountLabel} already holds ${uploaded.n} published ${uploaded.n === 1 ? 'sermon' : 'sermons'}. Reconnect that same account.`,
        );
      }
    }
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'channel.connect',
      entity: 'distribution_channel',
      entityId: 'youtube',
      diff: { provider: input.provider, account: label },
    });
  });
}

export const connectYouTube = (
  db: Db,
  actor: Actor,
  input: { refreshToken: string; email: string },
) =>
  connectYouTubeAccount(db, actor, {
    provider: 'youtube',
    config: { refreshToken: input.refreshToken },
    accountLabel: input.email,
  });

/** Development only: a stand-in channel that "uploads" to a folder on this machine. */
export const connectTestYouTube = (db: Db, actor: Actor) =>
  connectYouTubeAccount(db, actor, {
    provider: 'fake',
    config: {},
    accountLabel: 'Test channel (development)',
  });

export async function saveYouTubeSettings(
  db: Db,
  actor: Actor,
  input: unknown,
): Promise<YouTubeSettings> {
  assertCan(actor.role, 'connections.manage');
  const parsed = youtubeSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    throw new DistributionError('invalid', 'Check the highlighted settings.', fieldErrors);
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(distributionChannels)
      .where(eq(distributionChannels.kind, 'youtube'))
      .for('update');
    if (!row || !isConnected(row))
      throw new DistributionError('not_found', 'Connect YouTube first.');
    await tx
      .update(distributionChannels)
      .set({ settings: parsed.data, updatedAt: new Date() })
      .where(eq(distributionChannels.id, row.id));
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'channel.settings',
      entity: 'distribution_channel',
      entityId: 'youtube',
      diff: { from: readYouTubeSettings(row.settings), to: parsed.data },
    });
  });
  return parsed.data;
}

function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
  return fieldErrors;
}

/** Turns on, or saves the details of, a channel this app serves itself (podcast or library). */
async function saveAppServedChannel(
  db: Db,
  actor: Actor,
  kind: 'podcast' | 'library',
  settings: PodcastSettings | LibrarySettings,
) {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(distributionChannels)
      .where(eq(distributionChannels.kind, kind))
      .for('update');
    const turnedOn = !current || !isConnected(current);
    await upsertChannel(tx, kind, {
      provider: kind === 'podcast' ? 'feed' : 'site',
      settings,
      accountLabel: 'Served by this app',
      ...(turnedOn ? { connectedBy: actor.id, connectedAt: new Date(), disconnectedAt: null } : {}),
    });
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: turnedOn ? 'channel.connect' : 'channel.settings',
      entity: 'distribution_channel',
      entityId: kind,
      diff: { to: settings },
    });
  });
}

/**
 * Turns the podcast feed on, or saves its details. The feed is served by this app, so there is no
 * account to sign in to.
 */
export async function savePodcastSettings(
  db: Db,
  actor: Actor,
  input: unknown,
): Promise<PodcastSettings> {
  assertCan(actor.role, 'connections.manage');
  const parsed = podcastSettingsSchema.safeParse(input);
  if (!parsed.success)
    throw new DistributionError(
      'invalid',
      'Check the highlighted details.',
      fieldErrorsOf(parsed.error),
    );
  await saveAppServedChannel(db, actor, 'podcast', parsed.data);
  return parsed.data;
}

/** Turns the public online library on, or saves its name and description. */
export async function saveLibrarySettings(
  db: Db,
  actor: Actor,
  input: unknown,
): Promise<LibrarySettings> {
  assertCan(actor.role, 'connections.manage');
  const parsed = librarySettingsSchema.safeParse(input);
  if (!parsed.success)
    throw new DistributionError(
      'invalid',
      'Check the highlighted details.',
      fieldErrorsOf(parsed.error),
    );
  await saveAppServedChannel(db, actor, 'library', parsed.data);
  return parsed.data;
}

/**
 * YouTube: wipes the sign-in; videos stay as they are on YouTube. Podcast and library: stop being
 * served until turned on again; episodes keep their state and come back with it.
 */
export async function disconnectChannel(db: Db, actor: Actor, kind: ChannelKind): Promise<void> {
  assertCan(actor.role, 'connections.manage');
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(distributionChannels)
      .where(eq(distributionChannels.kind, kind))
      .for('update');
    if (!row || !isConnected(row))
      throw new DistributionError('not_found', 'That channel is not connected.');
    await tx
      .update(distributionChannels)
      .set({
        encryptedConfig: kind === 'youtube' ? null : row.encryptedConfig,
        disconnectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(distributionChannels.id, row.id));
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'channel.disconnect',
      entity: 'distribution_channel',
      entityId: kind,
      diff: { account: row.accountLabel },
    });
  });
}

export type { Visibility };
