import { AutoRefresh } from '@/components/AutoRefresh';
import { AdminOnlyBadge, PageHeader } from '@/components/shell/PageHeader';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { timeAgo } from '@/lib/format';
import { listTargets, type TargetStatus } from '@/lib/storage/connections';
import { latestVerification, listProblems, waitingToFile } from '@/lib/storage/filing';
import { isRealMode } from '@/lib/storage/google-client';
import { CheckButtons, ConnectButtons } from './ConnectionButtons';

export const metadata = { title: 'Connections' };

const CARD = {
  shared: {
    title: 'Shared archive drive',
    label: 'shared drive',
    copies: 'Cleaned audio, transcript, subtitles and details',
    layout: 'Decade / year / sermon folders',
  },
  backup: {
    title: 'Admin backup vault',
    label: 'backup',
    copies: 'Original and cleaned audio, word-timed transcript, text, subtitles, details',
    layout: 'Same folders, kept on a separate account',
  },
} as const;

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-t border-chip py-2.5 text-sm">
      <span className="flex-none text-faint">{name}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function Pill({ tone, children }: { tone: 'ok' | 'none' | 'warn'; children: React.ReactNode }) {
  const style = {
    ok: 'bg-spruce-tint text-spruce',
    none: 'bg-chip text-[#3d3930]',
    warn: 'bg-amber-tint text-amber-text',
  }[tone];
  return (
    <span
      className={`inline-flex h-[26px] items-center rounded-full px-2.5 text-[12.5px] font-semibold ${style}`}
    >
      {children}
    </span>
  );
}

function StorageCard({ target, realMode }: { target: TargetStatus; realMode: boolean }) {
  const card = CARD[target.role];
  const provider =
    target.provider === 'google_drive'
      ? 'Google Drive'
      : target.provider === 'local'
        ? 'Development folder'
        : '—';
  const { objects } = target;
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-surface p-[22px]">
      <div className="flex items-center gap-3">
        <div
          className={`flex size-10 flex-none items-center justify-center rounded-xl ${target.role === 'backup' ? 'bg-ink text-white' : 'bg-spruce-tint text-spruce'}`}
          aria-hidden="true"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {target.role === 'backup' ? (
              <>
                <path d="M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6z" />
                <path d="M8.5 12l2.5 2.5 4.5-5" />
              </>
            ) : (
              <path d="M7 18a4 4 0 01-.6-7.95A6 6 0 0117.7 9.5 4.3 4.3 0 0117 18z" />
            )}
          </svg>
        </div>
        <h3 className="m-0 flex-1 text-base font-semibold">{card.title}</h3>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {target.connected ? (
          <Pill tone="ok">Connected</Pill>
        ) : target.disconnectedAt ? (
          <Pill tone="warn">Disconnected</Pill>
        ) : (
          <Pill tone="none">Not connected</Pill>
        )}
        {target.role === 'backup' ? (
          <span className="inline-flex h-[26px] items-center rounded-full bg-ink px-2.5 text-[12.5px] font-semibold text-white">
            Admins only
          </span>
        ) : null}
      </div>
      <div className="mt-3.5 flex-1">
        <Row name="Provider">{provider}</Row>
        <Row name="Account">{target.accountLabel ?? '—'}</Row>
        <Row name="Top folder">
          <span className="font-mono text-[12.5px]">{target.rootFolderName}</span>
        </Row>
        <Row name="Layout">{card.layout}</Row>
        <Row name="Copies">{card.copies}</Row>
        <Row name="Files">
          {objects.total === 0
            ? 'None yet'
            : `${objects.verified} of ${objects.total} checked and intact`}
        </Row>
        <Row name="Last checked">
          {target.lastVerifiedAt ? timeAgo(target.lastVerifiedAt) : 'Not yet'}
        </Row>
      </div>
      <ConnectButtons
        role={target.role}
        label={card.label}
        connected={target.connected}
        realMode={realMode}
      />
    </div>
  );
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const user = await requireCapability('connections.manage');
  const db = getDb();
  const sp = await searchParams;
  const [targets, run, problems, waiting] = await Promise.all([
    listTargets(db, user),
    latestVerification(db, user),
    listProblems(db, user),
    waitingToFile(db),
  ]);
  const realMode = isRealMode();
  const bothConnected = targets.every((t) => t.connected);
  const checking = run?.state === 'queued' || run?.state === 'running';

  return (
    <>
      {checking ? <AutoRefresh everyMs={3000} /> : null}
      <PageHeader
        title="Connections"
        description="Choose where sermons are stored, where the backup lives, and where they’re shared with the world."
        aside={<AdminOnlyBadge />}
      />

      {sp.connected ? (
        <p
          role="status"
          className="m-0 rounded-xl bg-spruce-tint px-4 py-3 text-sm font-semibold text-spruce"
        >
          The {sp.connected === 'backup' ? 'backup' : 'shared drive'} is connected.
        </p>
      ) : null}
      {sp.error ? (
        <p
          role="alert"
          className="m-0 rounded-xl bg-[#f8e6e2] px-4 py-3 text-sm font-semibold text-danger"
        >
          {sp.error}
        </p>
      ) : null}

      <section aria-labelledby="storage-h">
        <h2
          id="storage-h"
          className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-faint"
        >
          Storage
        </h2>
        <div className="grid grid-cols-1 items-stretch gap-5 md:grid-cols-2">
          {targets.map((t) => (
            <StorageCard key={t.role} target={t} realMode={realMode} />
          ))}
        </div>
        <p className="mb-0 mt-3 text-[13px] text-muted">
          The two use different accounts, so anyone with access to the shared drive has none to the
          backup. Approved sermons are copied to both, and each file is read back and checked before
          a sermon counts as filed.
        </p>
      </section>

      <section
        aria-labelledby="check-h"
        className="rounded-2xl border border-line bg-surface p-[22px]"
      >
        <h2 id="check-h" className="m-0 text-[17px] font-semibold">
          Checking the copies
        </h2>
        <p className="mb-3 mt-1.5 text-sm text-muted">
          Every night, and whenever you ask, each filed file is looked up again and compared with
          what was filed. Nothing is repaired or replaced automatically.
        </p>
        <p className="mb-3.5 mt-0 text-sm" data-testid="last-check">
          {run
            ? run.state === 'queued' || run.state === 'running'
              ? 'Checking now…'
              : run.state === 'failed'
                ? `The last check could not finish${run.error ? `: ${run.error}` : '.'}`
                : `Last check ${run.finishedAt ? timeAgo(run.finishedAt) : ''}: ${run.verified} intact, ${run.drifted} changed, ${run.missing} missing.`
            : 'No check has run yet.'}
        </p>
        <CheckButtons waiting={waiting.length} canFile={bothConnected} checking={checking} />
      </section>

      {problems.length > 0 ? (
        <section
          aria-labelledby="problems-h"
          className="overflow-hidden rounded-2xl border border-[#e8c5be] bg-surface"
        >
          <h2
            id="problems-h"
            className="m-0 border-b border-chip bg-[#f8e6e2] px-6 py-4 text-[17px] font-semibold text-danger"
          >
            Files that need attention
          </h2>
          <ul className="m-0 list-none p-0">
            {problems.map((p) => (
              <li
                key={`${p.role}:${p.path}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-chip px-6 py-3 last:border-b-0"
              >
                <span className="w-24 text-[13px] font-semibold">
                  {p.state === 'missing' ? 'Missing' : 'Changed'}
                </span>
                <span className="w-28 text-[13px] text-muted">
                  {p.role === 'backup' ? 'Backup' : 'Shared drive'}
                </span>
                <span className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{p.path}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="dist-h">
        <h2
          id="dist-h"
          className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-faint"
        >
          Distribution
        </h2>
        <div className="rounded-2xl border border-dashed border-line-strong bg-paper px-6 py-8 text-center text-muted">
          YouTube and podcast publishing are added in a later step.
        </div>
      </section>
    </>
  );
}
