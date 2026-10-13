import Link from 'next/link';
import { AdminOnlyBadge, PageHeader } from '@/components/shell/PageHeader';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { timeAgo } from '@/lib/format';
import { getSystemHealth, type Tone } from '@/lib/health';

export const metadata = { title: 'System health' };

const STEP: Record<string, string> = {
  clean: 'Cleaning',
  transcribe: 'Transcribing',
  analyze: 'Naming and summarizing',
  file: 'Filing',
};

const DOT: Record<Tone, string> = { ok: 'bg-spruce', warn: 'bg-amber', bad: 'bg-danger' };

function gb(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function Check({
  id,
  title,
  tone,
  children,
}: {
  id?: string;
  title: string;
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id ?? title}-h`}
      className="flex flex-col gap-1.5 rounded-2xl border border-line bg-surface p-5"
    >
      <h2 id={`${id ?? title}-h`} className="m-0 flex items-center gap-2 text-[15px] font-semibold">
        <span className={`size-2.5 flex-none rounded-full ${DOT[tone]}`} aria-hidden="true" />
        {title}
        <span className="sr-only">
          {tone === 'ok'
            ? ' (working)'
            : tone === 'warn'
              ? ' (needs a look)'
              : ' (needs attention)'}
        </span>
      </h2>
      <div className="text-[14px] leading-[1.5] text-muted">{children}</div>
    </section>
  );
}

export default async function HealthPage() {
  const user = await requireCapability('settings.manage');
  const h = await getSystemHealth(getDb(), user);
  const backupTone: Tone =
    h.backup.kind === 'ok' ? 'ok' : h.backup.kind === 'none' ? 'warn' : 'bad';

  return (
    <>
      <PageHeader
        title="System health"
        description="Whether processing, backups, filing and publishing are working, in one place."
        aside={<AdminOnlyBadge />}
      />

      {h.attention.length === 0 ? (
        <p
          role="status"
          className="m-0 rounded-xl bg-spruce-tint px-4 py-3 text-sm font-semibold text-spruce"
        >
          Everything is working.
        </p>
      ) : (
        <section
          aria-labelledby="attention-h"
          className="rounded-2xl border border-[#e8c5be] bg-surface px-5 py-4"
        >
          <h2 id="attention-h" className="m-0 text-[15px] font-semibold text-danger">
            {h.attention.length === 1 ? 'One thing needs' : `${h.attention.length} things need`}{' '}
            attention
          </h2>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {h.attention.map((a) => (
              <li key={a.text} className="flex items-start gap-2 text-[14px]">
                <span
                  className={`mt-[7px] size-2 flex-none rounded-full ${DOT[a.tone]}`}
                  aria-hidden="true"
                />
                <Link href={a.href} className="text-ink underline underline-offset-2">
                  {a.text}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Check id="worker" title="Processing worker" tone={h.worker.online ? 'ok' : 'bad'}>
          {h.worker.online
            ? 'Running.'
            : h.worker.lastSeenAt
              ? `Stopped. Last seen ${timeAgo(h.worker.lastSeenAt)}.`
              : 'Has never run on this install.'}{' '}
          {h.queue.waiting} waiting, {h.queue.running} in progress.
        </Check>

        <Check title="Database backup" tone={backupTone}>
          {h.backup.kind === 'none'
            ? 'No backup recorded yet.'
            : h.backup.kind === 'failed'
              ? `Failed ${timeAgo(h.backup.at)}: ${h.backup.error}`
              : `Last good backup ${timeAgo(h.backup.at)}${h.backup.kind === 'stale' ? ', which is too long ago' : ''}.`}
        </Check>

        <Check
          title="Filing to the drives"
          tone={h.filing.problems ? 'bad' : h.filing.connected < 2 ? 'warn' : 'ok'}
        >
          {h.filing.connected === 2
            ? 'Both drives connected.'
            : `${h.filing.connected} of 2 drives connected.`}{' '}
          {h.filing.problems
            ? `${h.filing.problems} filed ${h.filing.problems === 1 ? 'file has' : 'files have'} changed or gone missing.`
            : 'No problems found in the last check.'}
        </Check>

        <Check title="Publishing" tone={h.publishing.failed ? 'warn' : 'ok'}>
          {h.publishing.failed ? `${h.publishing.failed} failed. ` : ''}
          {h.publishing.waiting} waiting or in progress.
          {h.publishing.youtubeCap !== null
            ? ` YouTube uploads in the last day: ${h.publishing.youtubeToday} of ${h.publishing.youtubeCap}.`
            : ' YouTube is not connected.'}
        </Check>

        <Check title="Storage used" tone="ok">
          Original tapes {gb(h.storage.originals)}, cleaned copies {gb(h.storage.cleaned)}
          {h.storage.videos ? `, YouTube videos ${gb(h.storage.videos)}` : ''}. Originals are never
          deleted, so this only grows.
        </Check>
      </div>

      <section
        id="failures"
        aria-labelledby="failures-h"
        className="overflow-hidden rounded-2xl border border-line bg-surface"
      >
        <h2
          id="failures-h"
          className="m-0 border-b border-chip px-5 py-4 text-[15px] font-semibold"
        >
          Processing failures this week
        </h2>
        {h.queue.recentFailures.length === 0 ? (
          <p className="m-0 px-5 py-4 text-sm text-muted">None.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {h.queue.recentFailures.map((f) => (
              <li key={f.id} className="border-b border-chip px-5 py-3 last:border-b-0">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <Link
                    href={`/sermons/${f.sermonId}`}
                    className="font-semibold text-ink underline underline-offset-2"
                  >
                    {f.sermonTitle ?? 'Untitled tape'}
                  </Link>
                  <span className="text-[13px] text-muted">
                    {STEP[f.type] ?? f.type}
                    {f.at ? `, ${timeAgo(f.at)}` : ''}
                  </span>
                </div>
                {f.error ? (
                  <details className="mt-1">
                    <summary className="min-h-11 cursor-pointer content-center text-[13px] font-semibold text-spruce">
                      Technical detail
                    </summary>
                    <pre className="m-0 whitespace-pre-wrap break-words rounded-lg bg-paper p-3 font-mono text-[12px]">
                      {f.error}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="m-0 text-[13px] text-muted">
        Detailed logs stay on your server:{' '}
        <code className="font-mono">docker compose logs web</code> and{' '}
        <code className="font-mono">docker compose logs worker</code>. When someone reports an error
        page, its reference appears in the web log.
      </p>
    </>
  );
}
