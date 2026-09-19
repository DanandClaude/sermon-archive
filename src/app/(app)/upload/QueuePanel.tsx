'use client';

import Link from 'next/link';
import { Icon } from '@/components/icons';
import { timeAgo } from '@/lib/format';
import {
  queueCounts,
  segmentFills,
  STATUS_LABEL,
  workerIsBlocking,
  type QueueRow,
  type RowStatus,
  type WorkerState,
} from '@/lib/uploads/queue';

const CHIP: Record<RowStatus, string> = {
  uploading: 'bg-amber-tint text-amber-text',
  interrupted: 'bg-amber-tint text-amber-text',
  uploaded: 'bg-chip text-muted',
  cleaning: 'bg-amber-tint text-amber-text',
  transcribing: 'bg-amber-tint text-amber-text',
  analyzing: 'bg-amber-tint text-amber-text',
  needs_review: 'bg-spruce-tint text-spruce',
  failed: 'bg-[#f8e6e2] text-danger',
  error: 'bg-[#f8e6e2] text-danger',
  cancelled: 'bg-chip text-muted',
};
const BUSY = new Set<RowStatus>(['uploading', 'cleaning', 'transcribing']);
const NO_LINK = new Set<RowStatus>(['uploading', 'interrupted', 'error', 'cancelled']);

function detail(row: QueueRow): string | undefined {
  const pct = row.percent === undefined ? '' : ` · ${row.percent}%`;
  switch (row.status) {
    case 'uploading':
      return `Uploading${pct}`;
    case 'interrupted':
      return 'Interrupted. Add this file again and it will carry on where it stopped.';
    case 'uploaded':
      return 'Uploaded. Waiting to be processed.';
    case 'cleaning':
      return `Reducing hiss and hum${pct}`;
    case 'transcribing':
      return `Transcribing${pct}`;
    case 'analyzing':
      return 'Naming, summarizing and finding the scripture references';
    case 'failed':
      return 'Something went wrong while processing.';
    default:
      return undefined;
  }
}

export function QueuePanel({
  rows,
  worker,
  onCancel,
  onDismiss,
  onRetry,
}: {
  rows: QueueRow[];
  worker: WorkerState | null;
  onCancel: (row: QueueRow) => void;
  onDismiss: (row: QueueRow) => void;
  onRetry: (row: QueueRow) => void;
}) {
  const { processing, ready } = queueCounts(rows);
  const paused = workerIsBlocking(rows, worker);
  return (
    <aside
      aria-label="Processing queue"
      className="flex w-full flex-none flex-col self-start overflow-hidden rounded-2xl border border-line bg-surface xl:w-[420px]"
    >
      <div className="border-b border-chip px-6 pb-4 pt-[22px]">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-[17px] font-semibold">Processing queue</h2>
          <div className="flex gap-1.5">
            {processing > 0 ? (
              <span className="inline-flex h-[26px] items-center whitespace-nowrap rounded-full bg-amber-tint px-2.5 text-[12.5px] font-semibold text-amber-text">
                {processing} processing
              </span>
            ) : null}
            {ready > 0 ? (
              <span className="inline-flex h-[26px] items-center whitespace-nowrap rounded-full bg-spruce-tint px-2.5 text-[12.5px] font-semibold text-spruce">
                {ready} ready
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-2 text-[12.5px] text-muted">
          Upload → Clean up → Transcribe → Name &amp; summarize → Review
        </div>
      </div>

      {paused ? (
        <div
          role="status"
          className="border-b border-chip bg-amber-tint px-6 py-3.5 text-[13px] leading-[1.45] text-amber-text"
        >
          <strong>Processing is paused.</strong> The audio worker isn’t running
          {worker?.lastSeenAt ? ` (last seen ${timeAgo(new Date(worker.lastSeenAt))})` : ''}. Your
          tapes are safe and will carry on when it starts.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="m-0 px-6 py-8 text-center text-[14px] text-muted">
          Nothing in the queue yet. Files you upload show up here.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map((row) => {
            const fills = segmentFills(row.status, row.percent);
            const text = row.error ?? detail(row);
            return (
              <li
                key={row.key}
                className="flex flex-col gap-2.5 border-b border-chip px-6 py-[18px] last:border-b-0"
              >
                <div className="flex items-center justify-between gap-3">
                  {row.sermonId && !NO_LINK.has(row.status) ? (
                    <Link
                      href={`/sermons/${row.sermonId}`}
                      className="min-w-0 break-all font-mono text-[13px] font-medium text-ink underline decoration-line-strong underline-offset-2"
                    >
                      {row.filename}
                    </Link>
                  ) : (
                    <span className="min-w-0 break-all font-mono text-[13px] font-medium">
                      {row.filename}
                    </span>
                  )}
                  <span
                    className={`inline-flex h-[26px] flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold ${CHIP[row.status]}`}
                  >
                    {BUSY.has(row.status) ? (
                      <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-amber" />
                    ) : null}
                    {STATUS_LABEL[row.status]}
                  </span>
                </div>
                <div
                  className="flex gap-1"
                  {...(row.status === 'uploading'
                    ? {
                        role: 'progressbar',
                        'aria-label': `Upload progress for ${row.filename}`,
                        'aria-valuemin': 0,
                        'aria-valuemax': 100,
                        'aria-valuenow': row.percent ?? 0,
                      }
                    : { 'aria-hidden': true })}
                >
                  {fills.map((fill, i) => (
                    <div key={i} className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-line">
                      <div
                        className={`h-full ${fill >= 1 ? 'bg-spruce' : row.status === 'uploading' ? 'bg-amber' : 'bg-spruce'}`}
                        style={{ width: `${Math.round(fill * 100)}%` }}
                      />
                    </div>
                  ))}
                </div>
                {text ? (
                  <div
                    className={`text-[12.5px] ${row.status === 'error' || row.status === 'failed' ? 'font-semibold text-danger' : 'text-muted'}`}
                  >
                    {text}
                  </div>
                ) : null}
                {row.status === 'uploading' && row.localId ? (
                  <button
                    type="button"
                    onClick={() => onCancel(row)}
                    className="inline-flex h-11 items-center self-start text-[13.5px] font-semibold text-muted"
                  >
                    Cancel<span className="sr-only"> upload of {row.filename}</span>
                  </button>
                ) : null}
                {row.status === 'failed' && row.sermonId && row.failedStage !== 'analyzing' ? (
                  <button
                    type="button"
                    onClick={() => onRetry(row)}
                    className="inline-flex h-11 items-center self-start rounded-[10px] border border-line-strong bg-surface px-4 text-[13.5px] font-semibold text-ink"
                  >
                    Retry<span className="sr-only"> {row.filename}</span>
                  </button>
                ) : null}
                {row.dismissible ? (
                  <button
                    type="button"
                    onClick={() => onDismiss(row)}
                    className="inline-flex h-11 items-center self-start text-[13.5px] font-semibold text-spruce"
                  >
                    Dismiss<span className="sr-only"> {row.filename}</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-start gap-2.5 border-t border-chip bg-paper px-6 py-4 text-[13px] leading-[1.45] text-muted">
        <span className="mt-px">
          <Icon name="lock" size={18} />
        </span>
        <span>
          Nothing goes public from here. Only admins can send sermons to YouTube or a podcast feed.
        </span>
      </div>
    </aside>
  );
}
