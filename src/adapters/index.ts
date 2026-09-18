import { getEnv } from '@/lib/env';
import { FakeDistributionChannel } from './distribution/fake';
import { FakeMailer } from './mail/fake';
import { SmtpMailer } from './mail/smtp';
import { join } from 'node:path';
import { FakeUploadStore } from './uploads/fake';
import { S3UploadStore } from './uploads/s3';
import type { UploadStore } from './uploads/types';
import type { Mailer } from './mail/types';
import type { ChannelKind, DistributionChannel } from './distribution/types';
import { resolveAdapterMode } from './mode';
import { FakeStorageProvider } from './storage/fake';
import type { StorageProvider } from './storage/types';

export type StorageRole = 'shared' | 'backup';

// One instance per process (and per dev hot reload) so fakes keep their state.
const globalForAdapters = globalThis as unknown as {
  __storage?: Map<StorageRole, StorageProvider>;
  __channels?: Map<ChannelKind, DistributionChannel>;
  __mailer?: Mailer;
  __uploadStore?: UploadStore;
};

function assertFakeMode(): void {
  if (resolveAdapterMode(getEnv()) === 'real') {
    // Real adapters are built in Phases 4 and 5.
    throw new Error('No real adapters exist yet.');
  }
}

export function getStorageProvider(role: StorageRole): StorageProvider {
  assertFakeMode();
  const map = (globalForAdapters.__storage ??= new Map());
  if (!map.has(role)) map.set(role, new FakeStorageProvider());
  return map.get(role)!;
}

export function getDistributionChannel(kind: ChannelKind): DistributionChannel {
  assertFakeMode();
  const map = (globalForAdapters.__channels ??= new Map());
  if (!map.has(kind)) map.set(kind, new FakeDistributionChannel(kind));
  return map.get(kind)!;
}

export function getMailer(): Mailer {
  const env = getEnv();
  if (resolveAdapterMode(env) === 'real') {
    // The env schema guarantees these are set in real mode.
    return (globalForAdapters.__mailer ??= new SmtpMailer(env.SMTP_URL!, env.MAIL_FROM!));
  }
  return (globalForAdapters.__mailer ??= new FakeMailer());
}

export function getUploadStore(): UploadStore {
  const env = getEnv();
  if (resolveAdapterMode(env) === 'real') {
    // The env schema guarantees these are set in real mode.
    return (globalForAdapters.__uploadStore ??= new S3UploadStore({
      bucket: env.S3_BUCKET!,
      region: env.S3_REGION!,
      endpoint: env.S3_ENDPOINT,
    }));
  }
  return (globalForAdapters.__uploadStore ??= new FakeUploadStore(
    join(process.cwd(), '.data', 'uploads'),
  ));
}
