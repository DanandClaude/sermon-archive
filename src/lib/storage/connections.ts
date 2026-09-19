import { count, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditLog, storageObjects, storageTargets } from '@/db/schema';
import { assertCan, type Actor } from '@/lib/permissions';
import { encryptJson } from '@/lib/secrets';

export type StorageRole = 'shared' | 'backup';
export const STORAGE_ROLES: readonly StorageRole[] = ['shared', 'backup'];

export const ROOT_FOLDER_NAME: Record<StorageRole, string> = {
  shared: 'Sermon Archive',
  backup: 'Sermon Archive Backup',
};

export type StorageErrorCode = 'invalid' | 'conflict' | 'not_found';

/** A storage action that could not be done, with a message fit to show an admin. */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export const isRole = (value: unknown): value is StorageRole =>
  value === 'shared' || value === 'backup';

export type TargetStatus = {
  role: StorageRole;
  connected: boolean;
  /** 'google_drive', 'local', or null when nothing has ever been connected. */
  provider: string | null;
  accountLabel: string | null;
  rootFolderName: string;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  lastVerifiedAt: Date | null;
  objects: { total: number; verified: number; drifted: number; missing: number; uploaded: number };
};

/** Both targets as the Connections screen shows them. Never includes credentials. */
export async function listTargets(db: Db, actor: Actor): Promise<TargetStatus[]> {
  assertCan(actor.role, 'connections.manage');
  const targets = await db.select().from(storageTargets);
  const counts = await db
    .select({ targetId: storageObjects.targetId, state: storageObjects.state, n: count() })
    .from(storageObjects)
    .groupBy(storageObjects.targetId, storageObjects.state);
  return STORAGE_ROLES.map((role) => {
    const row = targets.find((t) => t.role === role);
    const objects = { total: 0, verified: 0, drifted: 0, missing: 0, uploaded: 0 };
    for (const c of counts.filter((c) => c.targetId === row?.id)) {
      objects[c.state] += c.n;
      objects.total += c.n;
    }
    return {
      role,
      connected: !!row && row.disconnectedAt === null && row.encryptedConfig !== null,
      provider: row?.provider ?? null,
      accountLabel: row?.accountLabel ?? null,
      rootFolderName: row?.rootFolderName ?? ROOT_FOLDER_NAME[role],
      connectedAt: row?.connectedAt ?? null,
      disconnectedAt: row?.disconnectedAt ?? null,
      lastVerifiedAt: row?.lastVerifiedAt ?? null,
      objects,
    };
  });
}

type Connection = {
  provider: 'google_drive' | 'local';
  config: Record<string, unknown>;
  accountLabel: string;
};

/**
 * Saves a connection. The two targets must be different accounts so that someone with access to
 * the shared drive has none to the backup, and a target that already holds filed sermons can only
 * be reconnected to the account that holds them.
 */
async function saveConnection(db: Db, actor: Actor, role: StorageRole, input: Connection) {
  assertCan(actor.role, 'connections.manage');
  if (!isRole(role)) throw new StorageError('invalid', 'Choose the shared drive or the backup.');
  const label = input.accountLabel.trim();
  if (!label) throw new StorageError('invalid', 'The account could not be identified.');

  await db.transaction(async (tx) => {
    const rows = await tx.select().from(storageTargets).for('update');
    const other = rows.find((r) => r.role !== role);
    if (
      other &&
      other.disconnectedAt === null &&
      other.accountLabel?.toLowerCase() === label.toLowerCase()
    ) {
      throw new StorageError(
        'conflict',
        `${label} is already used for the ${other.role === 'shared' ? 'shared drive' : 'backup'}. Use a different account so the two stay separate.`,
      );
    }
    const existing = rows.find((r) => r.role === role);
    if (existing && existing.accountLabel?.toLowerCase() !== label.toLowerCase()) {
      const [filed] = await tx
        .select({ n: count() })
        .from(storageObjects)
        .where(eq(storageObjects.targetId, existing.id));
      if (filed.n > 0) {
        throw new StorageError(
          'conflict',
          `This target already holds ${filed.n} filed ${filed.n === 1 ? 'file' : 'files'} in ${existing.accountLabel}. Reconnect that same account.`,
        );
      }
    }
    const values = {
      provider: input.provider,
      encryptedConfig: encryptJson({ ...input.config, kind: input.provider }),
      accountLabel: label,
      rootFolderName: ROOT_FOLDER_NAME[role],
      connectedBy: actor.id,
      connectedAt: new Date(),
      disconnectedAt: null,
    };
    if (existing) {
      // A new account has a new folder tree, so the old folder id must not be reused.
      const sameAccount = existing.accountLabel?.toLowerCase() === label.toLowerCase();
      await tx
        .update(storageTargets)
        .set({ ...values, rootFolderId: sameAccount ? existing.rootFolderId : null })
        .where(eq(storageTargets.id, existing.id));
    } else {
      await tx.insert(storageTargets).values({ role, ...values });
    }
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'storage.connect',
      entity: 'storage_target',
      entityId: role,
      diff: { provider: input.provider, account: label },
    });
  });
}

export const connectGoogleDrive = (
  db: Db,
  actor: Actor,
  role: StorageRole,
  input: { refreshToken: string; email: string },
) =>
  saveConnection(db, actor, role, {
    provider: 'google_drive',
    config: { refreshToken: input.refreshToken },
    accountLabel: input.email,
  });

/** Development only: files to a folder on this machine. The caller chooses the folder. */
export const connectLocalFolder = (db: Db, actor: Actor, role: StorageRole, folder: string) =>
  saveConnection(db, actor, role, {
    provider: 'local',
    config: { path: folder },
    accountLabel: `Development folder (${role})`,
  });

/** Wipes the credentials. Filed files and their records stay, and the account is remembered. */
export async function disconnectTarget(db: Db, actor: Actor, role: StorageRole): Promise<void> {
  assertCan(actor.role, 'connections.manage');
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.role, role))
      .for('update');
    if (!row || row.disconnectedAt !== null || row.encryptedConfig === null) {
      throw new StorageError('not_found', 'That target is not connected.');
    }
    await tx
      .update(storageTargets)
      .set({ encryptedConfig: null, disconnectedAt: new Date() })
      .where(eq(storageTargets.id, row.id));
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: 'storage.disconnect',
      entity: 'storage_target',
      entityId: role,
      diff: { account: row.accountLabel },
    });
  });
}

/** True when both targets have credentials, which filing needs. */
export async function bothConnected(db: Pick<Db, 'select'>): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(storageTargets)
    .where(
      sql`${storageTargets.disconnectedAt} is null and ${storageTargets.encryptedConfig} is not null`,
    );
  return row.n === 2;
}
