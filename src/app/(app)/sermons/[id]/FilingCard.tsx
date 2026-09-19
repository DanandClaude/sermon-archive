import { timeAgo } from '@/lib/format';
import type { FilingSummary } from '@/lib/storage/filing';
import { RetryFilingButton } from './RetryFilingButton';

/** Whether an approved sermon has been filed, and for admins where each copy went. */
export function FilingCard({
  sermonId,
  status,
  summary,
  isAdmin,
  isOwner,
}: {
  sermonId: string;
  status: string;
  summary: FilingSummary;
  isAdmin: boolean;
  isOwner: boolean;
}) {
  const filed = status === 'filed';
  const filing = status === 'filing';
  // The reason is for the people who can act on it or who approved the sermon.
  const showError = summary.error && (isAdmin || isOwner);
  const changed =
    summary.files?.filter((f) => f.state === 'drifted' || f.state === 'missing') ?? [];
  return (
    <section
      aria-labelledby="filing-h"
      className="rounded-2xl border border-line bg-surface px-[22px] py-5"
    >
      <h2 id="filing-h" className="m-0 mb-2.5 text-[17px] font-semibold">
        Filing
      </h2>
      <p className="m-0 text-sm leading-[1.5]" data-testid="filing-state">
        {filed
          ? `Filed ${summary.filedAt ? timeAgo(summary.filedAt) : ''}. Both copies were read back and checked.`
          : filing
            ? 'Filing now…'
            : summary.error
              ? 'Filing has not finished yet.'
              : 'Waiting to be filed.'}
      </p>
      {showError ? (
        <p role="alert" className="mb-0 mt-2.5 text-[13.5px] font-semibold text-danger">
          {summary.error}
        </p>
      ) : null}
      {changed.length > 0 ? (
        <p role="alert" className="mb-0 mt-2.5 text-[13.5px] font-semibold text-danger">
          The latest check found {changed.length} {changed.length === 1 ? 'file' : 'files'} that no
          longer match. See the Connections page.
        </p>
      ) : null}
      {isAdmin && !filed && !filing ? (
        <div className="mt-3">
          <RetryFilingButton sermonId={sermonId} />
        </div>
      ) : null}
      {isAdmin && summary.files && summary.files.length > 0 ? (
        <details className="mt-3.5 text-[13px]">
          <summary className="cursor-pointer font-semibold text-spruce">
            Where the copies are ({summary.files.length})
          </summary>
          <ul className="m-0 mt-2 list-none p-0">
            {summary.files.map((f) => (
              <li key={`${f.role}:${f.path}`} className="border-t border-chip py-1.5">
                <span className="font-semibold">{f.role === 'backup' ? 'Backup' : 'Shared'}</span>
                {f.state === 'verified' ? '' : ` · ${f.state}`}
                <span className="block break-all font-mono text-xs text-muted">{f.path}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
