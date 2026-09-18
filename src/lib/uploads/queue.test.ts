import { describe, expect, it } from 'vitest';
import type { ItemState } from './client';
import {
  formatBytes,
  mergeQueue,
  percentOf,
  queueCounts,
  segmentFills,
  workerIsBlocking,
  type LocalUpload,
  type ServerQueueItem,
} from './queue';

const state = (over: Partial<ItemState>): ItemState => ({
  status: 'uploading',
  sentBytes: 0,
  totalBytes: 100,
  ...over,
});
const local = (name: string, over: Partial<ItemState>): LocalUpload => ({
  name,
  state: state(over),
});
const server = (id: string, status: string, filename = `${id}.wav`): ServerQueueItem => ({
  sermonId: id,
  uploadId: `u-${id}`,
  filename,
  status,
  sizeBytes: 100,
});

describe('percentOf', () => {
  it('rounds down and caps at 100', () => {
    expect(percentOf({ sentBytes: 82, totalBytes: 100 })).toBe(82);
    expect(percentOf({ sentBytes: 1, totalBytes: 3 })).toBe(33);
    expect(percentOf({ sentBytes: 200, totalBytes: 100 })).toBe(100);
    expect(percentOf({ sentBytes: 0, totalBytes: 0 })).toBe(0);
  });
});

describe('mergeQueue', () => {
  it('shows this tab’s live progress for an upload it is running', () => {
    const rows = mergeQueue([], {
      a: local('a.wav', { sentBytes: 40, sermonId: 's1', uploadId: 'u1' }),
    });
    expect(rows).toEqual([
      expect.objectContaining({
        filename: 'a.wav',
        status: 'uploading',
        percent: 40,
        localId: 'a',
        uploadId: 'u1',
        dismissible: false,
      }),
    ]);
  });

  it('does not list a running upload twice when the server also knows about it', () => {
    const rows = mergeQueue([server('s1', 'uploading', 'a.wav')], {
      a: local('a.wav', { sentBytes: 40, sermonId: 's1' }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('uploading');
  });

  it('after a local upload finishes, shows the server status', () => {
    const rows = mergeQueue([server('s1', 'transcribing')], {
      a: local('a.wav', { status: 'done', sentBytes: 100, sermonId: 's1' }),
    });
    expect(rows.map((r) => r.status)).toEqual(['transcribing']);
  });

  it('shows a just-finished upload as uploaded until the server lists it', () => {
    const rows = mergeQueue([], {
      a: local('a.wav', { status: 'done', sentBytes: 100, sermonId: 's1' }),
    });
    expect(rows).toEqual([expect.objectContaining({ status: 'uploaded', filename: 'a.wav' })]);
  });

  it('marks a server-side upload that this tab is not sending as interrupted', () => {
    const rows = mergeQueue([server('s9', 'uploading', 'old.wav')], {});
    expect(rows).toEqual([expect.objectContaining({ status: 'interrupted', filename: 'old.wav' })]);
  });

  it('keeps failed and cancelled local uploads visible and dismissible', () => {
    const rows = mergeQueue([], {
      a: local('a.wav', { status: 'error', error: 'Nope' }),
      b: local('b.wav', { status: 'cancelled' }),
    });
    expect(rows.map((r) => [r.status, r.dismissible, r.error])).toEqual([
      ['error', true, 'Nope'],
      ['cancelled', true, undefined],
    ]);
  });

  it('lists server-only sermons after the tab’s own uploads, in the server’s order', () => {
    const rows = mergeQueue([server('s2', 'needs_review'), server('s3', 'uploaded')], {
      a: local('a.wav', { sentBytes: 10 }),
    });
    expect(rows.map((r) => r.filename)).toEqual(['a.wav', 's2.wav', 's3.wav']);
  });
});

describe('segmentFills', () => {
  it('fills the upload segment as the file goes up', () => {
    expect(segmentFills('uploading', 82)).toEqual([0.82, 0, 0, 0, 0]);
  });
  it('shows upload complete and processing not yet started once uploaded', () => {
    expect(segmentFills('uploaded')).toEqual([1, 0, 0, 0, 0]);
  });
  it('fills earlier stages fully as the sermon moves on', () => {
    expect(segmentFills('transcribing')).toEqual([1, 1, 0, 0, 0]);
    expect(segmentFills('needs_review')).toEqual([1, 1, 1, 1, 0]);
  });
  it('shows an empty bar for failures', () => {
    expect(segmentFills('error')).toEqual([0, 0, 0, 0, 0]);
    expect(segmentFills('failed')).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('queueCounts', () => {
  it('counts what is still processing and what is ready for review', () => {
    const rows = mergeQueue(
      [
        server('a', 'uploaded'),
        server('b', 'cleaning'),
        server('c', 'needs_review'),
        server('d', 'failed'),
      ],
      {},
    );
    expect(queueCounts(rows)).toEqual({ processing: 2, ready: 1 });
  });
});

describe('formatBytes', () => {
  it.each([
    [500, '500 B'],
    [2048, '2 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [65 * 1024 * 1024, '65 MB'],
    [1.5 * 1024 * 1024 * 1024, '1.5 GB'],
  ])('%d → %s', (n, text) => expect(formatBytes(n)).toBe(text));
});

describe('processing stages from the server', () => {
  const withProgress = (id: string, status: string, progress: number | null, extra = {}) => ({
    ...server(id, status),
    progress,
    ...extra,
  });

  it('shows the running stage’s own progress', () => {
    const [row] = mergeQueue([withProgress('s1', 'transcribing', 64)], {});
    expect(row).toMatchObject({ status: 'transcribing', percent: 64, sermonId: 's1' });
  });

  it('fills the current segment as cleanup and transcription progress', () => {
    expect(segmentFills('cleaning', 31)).toEqual([1, 0.31, 0, 0, 0]);
    expect(segmentFills('transcribing', 64)).toEqual([1, 1, 0.64, 0, 0]);
    expect(segmentFills('analyzing', 0)).toEqual([1, 1, 1, 0, 0]);
  });

  it('carries a failed sermon’s reason so the row can show it', () => {
    const [row] = mergeQueue(
      [
        withProgress('s1', 'failed', null, {
          failedStage: 'transcribing',
          lastError: 'No speech was detected in this recording.',
        }),
      ],
      {},
    );
    expect(row).toMatchObject({
      status: 'failed',
      error: 'No speech was detected in this recording.',
      sermonId: 's1',
    });
  });

  it('calls a finished transcript ready, not still processing', () => {
    const rows = mergeQueue(
      [withProgress('a', 'analyzing', null), withProgress('b', 'cleaning', 10)],
      {},
    );
    expect(queueCounts(rows)).toEqual({ processing: 2, ready: 0 });
    expect(rows[0].status).toBe('analyzing');
  });
});

describe('workerIsBlocking', () => {
  const offline = { online: false, lastSeenAt: null };
  const online = { online: true, lastSeenAt: '2026-01-01T00:00:00Z' };
  const waiting = mergeQueue([server('a', 'uploaded')], {});

  it('is true when something is waiting and the worker is not running', () => {
    expect(workerIsBlocking(waiting, offline)).toBe(true);
    expect(workerIsBlocking(mergeQueue([server('a', 'transcribing')], {}), offline)).toBe(true);
  });

  it('is false when the worker is running, unknown, or nothing needs it', () => {
    expect(workerIsBlocking(waiting, online)).toBe(false);
    expect(workerIsBlocking(waiting, null)).toBe(false);
    expect(
      workerIsBlocking(
        mergeQueue([server('a', 'needs_review'), server('b', 'failed')], {}),
        offline,
      ),
    ).toBe(false);
    expect(workerIsBlocking([], offline)).toBe(false);
  });
});
