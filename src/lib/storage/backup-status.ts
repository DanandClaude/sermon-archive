import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { settings } from '@/db/schema';
import { assertCan, type Actor } from '@/lib/permissions';

export type BackupState =
  | { kind: 'none' }
  | { kind: 'ok'; at: Date; bytes: number; encrypted: boolean }
  | { kind: 'stale'; at: Date; bytes: number; encrypted: boolean }
  | { kind: 'failed'; at: Date; error: string };

/** A backup should happen every night. Past this long without one, the admin is warned. */
export const STALE_AFTER_HOURS = 36;

/** What the nightly database backup last did, as saved by the backup service. Admins only. */
export async function getBackupState(db: Db, actor: Actor, now = new Date()): Promise<BackupState> {
  assertCan(actor.role, 'connections.manage');
  const [row] = await db.select().from(settings).where(eq(settings.key, 'backup_last'));
  const v = row?.value as
    { ok?: boolean; at?: string; bytes?: number; encrypted?: boolean; error?: string } | undefined;
  const at = v?.at ? new Date(v.at) : null;
  if (!v || !at || Number.isNaN(at.getTime())) return { kind: 'none' };
  if (!v.ok) return { kind: 'failed', at, error: v.error ?? 'The backup did not finish.' };
  const detail = { at, bytes: v.bytes ?? 0, encrypted: !!v.encrypted };
  const hours = (now.getTime() - at.getTime()) / 3_600_000;
  return hours > STALE_AFTER_HOURS ? { kind: 'stale', ...detail } : { kind: 'ok', ...detail };
}
