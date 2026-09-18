import { PageHeader } from '@/components/shell/PageHeader';
import { Icon } from '@/components/icons';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { listQueue } from '@/lib/uploads/service';
import { getSettings } from '@/lib/settings';
import { UploadClient } from './UploadClient';

export const metadata = { title: 'Upload tapes' };

export default async function UploadPage() {
  const user = await requireCapability('sermon.upload');
  const db = getDb();
  const [{ defaultSpeaker }, queue] = await Promise.all([getSettings(db), listQueue(db, user)]);
  return (
    <>
      <PageHeader
        title="Upload cassette tapes"
        description="Drop in your digitized recordings. We’ll clean up the audio, transcribe it, then name and file each sermon for you."
        aside={
          <div className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-muted">
            <span className="text-spruce">
              <Icon name="connections" size={18} />
            </span>
            <span>Saves to the shared drive once you approve</span>
          </div>
        }
      />
      <UploadClient
        defaultSpeaker={defaultSpeaker}
        initialQueue={queue.map(({ sermonId, uploadId, filename, status, sizeBytes }) => ({
          sermonId,
          uploadId,
          filename,
          status,
          sizeBytes,
        }))}
      />
    </>
  );
}
