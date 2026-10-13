import Link from 'next/link';
import { StatusChip } from '@/components/StatusChip';
import { formatClock, formatRecordedOn } from '@/lib/format';
import type { LibraryRow } from '@/lib/sermons/library';

/** The Library as cards: easier to scan by passage and summary than the table. */
export function LibraryGrid({ rows }: { rows: LibraryRow[] }) {
  return (
    <ul
      aria-label="Sermons"
      className="m-0 grid list-none grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {rows.map((row) => {
        const recorded = formatRecordedOn(row.recordedOn);
        return (
          <li
            key={row.id}
            className="relative flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 focus-within:ring-2 focus-within:ring-spruce hover:border-line-strong"
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="m-0 min-w-0 text-[15.5px] font-semibold leading-snug">
                <Link
                  href={`/sermons/${row.id}`}
                  className="text-ink outline-none after:absolute after:inset-0 after:rounded-xl"
                >
                  {row.title ?? (
                    <span className="break-all font-mono text-[13px] font-medium">
                      {row.filename ?? 'Untitled tape'}
                    </span>
                  )}
                </Link>
              </h3>
              <span className="flex-none">
                <StatusChip status={row.status} />
              </span>
            </div>
            <p className="m-0 text-[14px] font-semibold text-spruce">
              {row.labelScripture ?? <span className="font-normal text-faint">No passage yet</span>}
            </p>
            {row.summary ? (
              <p className="m-0 line-clamp-3 text-[13.5px] leading-[1.5] text-muted">
                {row.summary}
              </p>
            ) : null}
            <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[12.5px] text-muted">
              <span>
                {recorded ?? <span className="font-semibold text-amber-text">Date needed</span>}
              </span>
              {row.durationSec ? (
                <span className="font-mono">{formatClock(row.durationSec)}</span>
              ) : null}
              <span>{row.contributorName}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
