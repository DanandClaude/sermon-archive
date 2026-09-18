import { notFound } from 'next/navigation';
import { getUploadStore } from '@/adapters';
import { PageHeader } from '@/components/shell/PageHeader';
import { StatusChip } from '@/components/StatusChip';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { formatRecordedOn, timeAgo } from '@/lib/format';
import { getWorkerStatus, runningProgress } from '@/lib/jobs';
import { getSermonDetail, isUuid } from '@/lib/sermons/detail';
import { AutoRefresh } from './AutoRefresh';
import { RetryButton } from './RetryButton';
import { SermonPlayer } from './SermonPlayer';

export const metadata = { title: 'Sermon' };

const PROCESSING = ['uploaded', 'cleaning', 'transcribing'] as const;
const STAGE_TEXT: Record<string, string> = {
  uploaded: 'Uploaded. Waiting to be processed.',
  cleaning: 'Cleaning up the audio',
  transcribing: 'Transcribing',
  analyzing: 'The transcript is ready. Naming and summarizing come next.',
};
const READ_URL_SECONDS = 60 * 60;

export default async function SermonPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCapability('library.browse');
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const db = getDb();
  const detail = await getSermonDetail(db, user, id);
  if (!detail) notFound();

  const store = getUploadStore();
  const [originalUrl, cleanedUrl] = await Promise.all([
    detail.original
      ? store.presignRead({ key: detail.original.storageKey, expiresInSec: READ_URL_SECONDS })
      : null,
    detail.cleaned
      ? store.presignRead({ key: detail.cleaned.storageKey, expiresInSec: READ_URL_SECONDS })
      : null,
  ]);
  const processing = (PROCESSING as readonly string[]).includes(detail.status);
  const [progress, worker] = processing
    ? await Promise.all([runningProgress(db, id), getWorkerStatus(db)])
    : [null, null];

  const recorded = formatRecordedOn(detail.recordedOn);
  const meta = [
    recorded ?? 'Date needed',
    detail.speaker,
    detail.side ? `Side ${detail.side}` : null,
    detail.batchLabel,
  ]
    .filter(Boolean)
    .join(' · ');
  const title = detail.title ?? detail.filename ?? 'Untitled tape';

  return (
    <>
      {processing || detail.status === 'analyzing' ? <AutoRefresh /> : null}
      <PageHeader title={title} description={meta} aside={<StatusChip status={detail.status} />} />

      {detail.status === 'failed' ? (
        <section
          role="alert"
          className="rounded-2xl border border-[#e8c5be] bg-[#f8e6e2] px-6 py-[22px]"
        >
          <h2 className="m-0 text-[17px] font-semibold text-danger">This step failed</h2>
          <p className="mb-4 mt-1.5 text-[14.5px]">
            {detail.lastError ?? 'Something went wrong while processing.'}
          </p>
          {detail.canRetry && detail.failedStage !== 'analyzing' ? (
            <RetryButton sermonId={detail.id} />
          ) : null}
        </section>
      ) : STAGE_TEXT[detail.status] ? (
        <section className="rounded-2xl border border-line bg-surface px-6 py-[22px]">
          <h2 className="m-0 text-[17px] font-semibold">
            {STAGE_TEXT[detail.status]}
            {progress !== null ? ` · ${progress}%` : ''}
          </h2>
          {worker && !worker.online ? (
            <p className="mb-0 mt-1.5 text-[13.5px] text-amber-text">
              The audio worker isn’t running
              {worker.lastSeenAt ? ` (last seen ${timeAgo(worker.lastSeenAt)})` : ''}. This will
              carry on when it starts.
            </p>
          ) : null}
        </section>
      ) : null}

      {originalUrl ? (
        <SermonPlayer
          originalUrl={originalUrl.url}
          cleanedUrl={cleanedUrl?.url ?? null}
          segments={detail.transcript?.segments ?? []}
          lowConfidence={detail.transcript?.lowConfidence ?? []}
        />
      ) : null}

      {detail.transcript ? (
        <section
          aria-labelledby="downloads"
          className="rounded-2xl border border-line bg-surface px-6 py-[22px]"
        >
          <h2 id="downloads" className="m-0 text-[17px] font-semibold">
            Download the transcript
          </h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {[
              ['srt', 'Subtitles (SRT)'],
              ['vtt', 'Subtitles (VTT)'],
              ['txt', 'Plain text'],
            ].map(([format, label]) => (
              <a
                key={format}
                href={`/api/sermons/${detail.id}/transcript?format=${format}`}
                download
                className="inline-flex h-11 items-center rounded-xl border border-line-strong bg-surface px-[18px] text-[14.5px] font-semibold text-ink"
              >
                {label}
              </a>
            ))}
          </div>
          <p className="mb-0 mt-3 text-[13px] text-muted">
            Transcribed by {detail.transcript.model} · version {detail.transcript.version}
          </p>
        </section>
      ) : null}

      <section
        aria-labelledby="details"
        className="rounded-2xl border border-line bg-surface px-6 py-[22px]"
      >
        <h2 id="details" className="m-0 mb-3 text-[17px] font-semibold">
          Details
        </h2>
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-8 gap-y-2 text-[14.5px]">
          <dt className="text-muted">File</dt>
          <dd className="m-0 break-all font-mono text-[13px]">{detail.filename ?? '—'}</dd>
          <dt className="text-muted">Scripture on label</dt>
          <dd className="m-0">{detail.labelScripture ?? '—'}</dd>
          <dt className="text-muted">Length</dt>
          <dd className="m-0">
            {detail.durationSec
              ? `${Math.floor(detail.durationSec / 60)} min ${detail.durationSec % 60} s`
              : '—'}
          </dd>
          <dt className="text-muted">Uploaded by</dt>
          <dd className="m-0">
            {detail.contributorName}, {timeAgo(detail.createdAt)}
          </dd>
        </dl>
      </section>

      {detail.jobs ? (
        <section
          aria-labelledby="jobs"
          className="overflow-hidden rounded-2xl border border-line bg-surface"
        >
          <h2
            id="jobs"
            className="m-0 border-b border-chip px-6 pb-3.5 pt-[22px] text-[17px] font-semibold"
          >
            Processing history <span className="font-normal text-muted">· admins only</span>
          </h2>
          {detail.jobs.length === 0 ? (
            <p className="m-0 px-6 py-5 text-[14px] text-muted">No jobs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[13.5px]">
                <thead>
                  <tr className="border-b border-chip text-[12px] uppercase tracking-[0.06em] text-muted">
                    <th scope="col" className="px-6 py-3 font-semibold">
                      Step
                    </th>
                    <th scope="col" className="px-3 py-3 font-semibold">
                      State
                    </th>
                    <th scope="col" className="px-3 py-3 font-semibold">
                      Attempts
                    </th>
                    <th scope="col" className="px-3 py-3 font-semibold">
                      Started
                    </th>
                    <th scope="col" className="px-6 py-3 font-semibold">
                      Last error
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.jobs.map((job) => (
                    <tr key={job.id} className="border-b border-chip last:border-b-0">
                      <td className="px-6 py-3 align-top">{job.type}</td>
                      <td className="px-3 py-3 align-top">{job.state}</td>
                      <td className="px-3 py-3 align-top">
                        {job.attempts}/{job.maxAttempts}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 align-top">
                        {job.startedAt ? timeAgo(job.startedAt) : '—'}
                      </td>
                      <td className="max-w-[420px] break-words px-6 py-3 align-top font-mono text-[12px] text-muted">
                        {job.lastError ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
