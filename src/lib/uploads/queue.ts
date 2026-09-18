import type { ItemState } from './client';

/** What the server knows about a sermon that is still moving through the pipeline. */
export type ServerQueueItem = {
  sermonId: string;
  uploadId: string | null;
  filename: string;
  status: string;
  sizeBytes: number | null;
};

/** An upload started in this browser tab. */
export type LocalUpload = { name: string; state: ItemState };

export type RowStatus =
  | 'uploading'
  | 'interrupted'
  | 'uploaded'
  | 'cleaning'
  | 'transcribing'
  | 'analyzing'
  | 'needs_review'
  | 'failed'
  | 'error'
  | 'cancelled';

export type QueueRow = {
  key: string;
  filename: string;
  status: RowStatus;
  /** 0-100 while uploading from this tab. */
  percent?: number;
  /** Set when this tab is running the upload and can cancel it. */
  localId?: string;
  uploadId?: string | null;
  error?: string;
  dismissible: boolean;
};

const ACTIVE_LOCAL = new Set(['waiting', 'starting', 'uploading', 'finishing']);

export function percentOf(state: { sentBytes: number; totalBytes: number }): number {
  return state.totalBytes === 0
    ? 0
    : Math.min(100, Math.floor((state.sentBytes / state.totalBytes) * 100));
}

/**
 * Combines uploads running in this tab with what the server lists. A tab's own view wins while
 * it is actively uploading; afterwards the server is the source of truth. A sermon the server
 * says is still `uploading` but that this tab isn't sending was interrupted (page reloaded).
 */
export function mergeQueue(
  server: ServerQueueItem[],
  local: Record<string, LocalUpload>,
): QueueRow[] {
  const rows: QueueRow[] = [];

  for (const [localId, { name, state }] of Object.entries(local)) {
    if (ACTIVE_LOCAL.has(state.status)) {
      rows.push({
        key: `local:${localId}`,
        filename: name,
        status: 'uploading',
        percent: percentOf(state),
        localId,
        uploadId: state.uploadId,
        dismissible: false,
      });
    } else if (state.status === 'error') {
      rows.push({
        key: `local:${localId}`,
        filename: name,
        status: 'error',
        error: state.error,
        localId,
        dismissible: true,
      });
    } else if (state.status === 'cancelled') {
      rows.push({
        key: `local:${localId}`,
        filename: name,
        status: 'cancelled',
        localId,
        dismissible: true,
      });
    } else if (
      state.status === 'done' &&
      state.sermonId &&
      !server.some((s) => s.sermonId === state.sermonId)
    ) {
      // Finished here but not in the server's list yet: show it as uploaded rather than blinking away.
      rows.push({
        key: `sermon:${state.sermonId}`,
        filename: name,
        status: 'uploaded',
        localId,
        dismissible: false,
      });
    }
  }

  for (const item of server) {
    const local_ = Object.values(local).find((l) => l.state.sermonId === item.sermonId);
    if (local_ && ACTIVE_LOCAL.has(local_.state.status)) continue;
    const status: RowStatus =
      item.status === 'uploading' ? 'interrupted' : (item.status as RowStatus);
    rows.push({
      key: `sermon:${item.sermonId}`,
      filename: item.filename,
      status,
      uploadId: item.uploadId,
      dismissible: false,
    });
  }
  return rows;
}

export const STAGE_COUNT = 5;
const STAGE_INDEX: Partial<Record<RowStatus, number>> = {
  uploading: 0,
  interrupted: 0,
  uploaded: 1,
  cleaning: 1,
  transcribing: 2,
  analyzing: 3,
  needs_review: 4,
};

/**
 * Fill for the five bar segments (Upload, Clean up, Transcribe, Name & summarize, Review), each
 * 0 to 1. Stages before the current one are full; the current one is partly full while uploading.
 */
export function segmentFills(status: RowStatus, percent = 0): number[] {
  const index = STAGE_INDEX[status];
  if (index === undefined) return Array(STAGE_COUNT).fill(0);
  return Array.from({ length: STAGE_COUNT }, (_, i) => {
    if (i < index) return 1;
    if (i === index) return status === 'uploading' ? percent / 100 : 0;
    return 0;
  });
}

export const STATUS_LABEL: Record<RowStatus, string> = {
  uploading: 'Uploading',
  interrupted: 'Interrupted',
  uploaded: 'Waiting to process',
  cleaning: 'Cleaning audio',
  transcribing: 'Transcribing',
  analyzing: 'Naming & summarizing',
  needs_review: 'Ready to review',
  failed: 'Needs attention',
  error: 'Upload failed',
  cancelled: 'Cancelled',
};

/** Only the two counts the mockup's header shows. */
export function queueCounts(rows: QueueRow[]): { processing: number; ready: number } {
  return {
    processing: rows.filter((r) =>
      ['uploading', 'uploaded', 'cleaning', 'transcribing', 'analyzing'].includes(r.status),
    ).length,
    ready: rows.filter((r) => r.status === 'needs_review').length,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
