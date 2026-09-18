import { describe, expect, it } from 'vitest';
import {
  CancelledError,
  HttpError,
  NetworkError,
  UploadManager,
  type ItemState,
  type UploadItem,
  type UploaderDeps,
} from './client';

const PART = 10;

function makeFile(name: string, size: number, lastModified = 1) {
  return {
    name,
    size,
    lastModified,
    slice: (s: number, e: number) => ({ size: Math.min(e, size) - s }),
  };
}
const item = (id: string, size: number, name = `${id}.wav`): UploadItem => ({
  id,
  file: makeFile(name, size),
  details: { batchLabel: 'Box 3' },
});

type Knobs = {
  /** Part numbers whose first PUT fails with a dropped connection. */
  dropPutOnce?: number[];
  failAllPuts?: boolean;
  /** Parts the server reports as missing after the first complete call. */
  loseParts?: number[];
  startError?: { status: number; body: Record<string, unknown> };
  alreadyHave?: number[];
  putStatus403Once?: boolean;
};

function makeServer(knobs: Knobs = {}) {
  const log: string[] = [];
  const delays: number[] = [];
  const received = new Map<number, number>();
  const puts: number[] = [];
  let concurrentStarts = 0;
  let maxConcurrentStarts = 0;
  let lost = false;
  const dropped = new Set(knobs.dropPutOnce ?? []);
  let forbidden = knobs.putStatus403Once ?? false;
  let total = 0;

  const deps: UploaderDeps = {
    async request(method, path, body) {
      log.push(`${method} ${path}`);
      if (method === 'POST' && path === '/api/uploads') {
        concurrentStarts++;
        maxConcurrentStarts = Math.max(maxConcurrentStarts, concurrentStarts);
        await Promise.resolve();
        concurrentStarts--;
        if (knobs.startError) return knobs.startError;
        const size = (body as { sizeBytes: number }).sizeBytes;
        total = Math.ceil(size / PART);
        for (const n of knobs.alreadyHave ?? [])
          received.set(n, n < total ? PART : size - PART * (total - 1));
        return {
          status: 201,
          body: {
            uploadId: 'u1',
            sermonId: 's1',
            partSize: PART,
            totalParts: total,
            completedParts: (knobs.alreadyHave ?? []).map((n) => ({
              partNumber: n,
              size: received.get(n)!,
            })),
            resumed: Boolean(knobs.alreadyHave?.length),
          },
        };
      }
      if (path.endsWith('/parts')) {
        return {
          status: 200,
          body: { url: `put://u1/${(body as { partNumber: number }).partNumber}` },
        };
      }
      if (path.endsWith('/complete')) {
        if (knobs.loseParts && !lost) {
          lost = true;
          for (const n of knobs.loseParts) received.delete(n);
        }
        const missing = Array.from({ length: total }, (_, i) => i + 1).filter(
          (n) => !received.has(n),
        );
        return missing.length
          ? {
              status: 409,
              body: {
                code: 'incomplete',
                error: 'Some parts did not arrive.',
                missingParts: missing,
              },
            }
          : { status: 200, body: { sermonId: 's1', status: 'uploaded' } };
      }
      if (method === 'DELETE') return { status: 204, body: {} };
      throw new Error(`unexpected ${method} ${path}`);
    },
    async putPart(url, blob, onProgress, signal) {
      const n = Number(url.split('/').pop());
      if (signal.aborted) throw new CancelledError();
      puts.push(n);
      if (knobs.failAllPuts) throw new NetworkError();
      if (dropped.delete(n)) throw new NetworkError();
      if (forbidden) {
        forbidden = false;
        throw new HttpError(403, 'expired');
      }
      onProgress(blob.size);
      received.set(n, blob.size);
    },
    async sleep(ms) {
      delays.push(ms);
    },
  };
  return {
    deps,
    log,
    delays,
    puts,
    received,
    get maxConcurrentStarts() {
      return maxConcurrentStarts;
    },
  };
}

function run(server: ReturnType<typeof makeServer>, items: UploadItem[], options = {}) {
  const states = new Map<string, ItemState>();
  const history: ItemState[] = [];
  const manager = new UploadManager(server.deps, (id, s) => (states.set(id, s), history.push(s)), {
    baseDelayMs: 100,
    ...options,
  });
  return { manager, states, history, done: manager.run(items) };
}

describe('UploadManager', () => {
  it('sends every part, completes, and reports progress up to the full size', async () => {
    const server = makeServer();
    const { states, history, done } = run(server, [item('a', 35)]);
    await done;
    expect(states.get('a')).toMatchObject({
      status: 'done',
      sentBytes: 35,
      totalBytes: 35,
      sermonId: 's1',
      uploadId: 'u1',
    });
    expect([...server.puts].sort()).toEqual([1, 2, 3, 4]);
    expect(server.log.filter((l) => l.endsWith('/complete'))).toHaveLength(1);
    const sent = history.map((h) => h.sentBytes);
    expect(sent).toEqual([...sent].sort((a, b) => a - b)); // never goes backwards
  });

  it('sends the label details along when starting', async () => {
    const server = makeServer();
    const seen: unknown[] = [];
    const original = server.deps.request;
    server.deps.request = async (m, p, b) => (
      m === 'POST' && p === '/api/uploads' && seen.push(b),
      original(m, p, b)
    );
    await run(server, [item('a', 12)]).done;
    expect(seen[0]).toMatchObject({
      filename: 'a.wav',
      sizeBytes: 12,
      lastModified: 1,
      details: { batchLabel: 'Box 3' },
    });
  });

  it('resumes: parts the server already has are not sent again', async () => {
    const server = makeServer({ alreadyHave: [1, 2] });
    const { states, done } = run(server, [item('a', 35)]);
    await done;
    expect([...server.puts].sort()).toEqual([3, 4]);
    expect(states.get('a')).toMatchObject({ status: 'done', resumed: true, sentBytes: 35 });
  });

  it('retries a dropped part with growing delays, asking for a fresh URL each time', async () => {
    const server = makeServer({ dropPutOnce: [2] });
    const { states, done } = run(server, [item('a', 35)]);
    await done;
    expect(states.get('a')?.status).toBe('done');
    expect(server.puts.filter((n) => n === 2)).toHaveLength(2);
    expect(server.log.filter((l) => l.endsWith('/parts'))).toHaveLength(5);
    expect(server.delays).toEqual([100]);
  });

  it('retries once when a presigned URL has expired (403)', async () => {
    const server = makeServer({ putStatus403Once: true });
    const { states, done } = run(server, [item('a', 12)]);
    await done;
    expect(states.get('a')?.status).toBe('done');
  });

  it('gives up after the maximum attempts and never calls complete', async () => {
    const server = makeServer({ failAllPuts: true });
    const { states, done } = run(server, [item('a', 12)], { maxAttempts: 3, partConcurrency: 1 });
    await done;
    expect(states.get('a')?.status).toBe('error');
    expect(states.get('a')?.error).toMatch(/Add the file again/);
    expect(server.puts).toHaveLength(3);
    expect(server.delays).toEqual([100, 200]);
    expect(server.log.some((l) => l.endsWith('/complete'))).toBe(false);
  });

  it('shows the server’s message for a rejected file and does not retry it', async () => {
    const server = makeServer({
      startError: {
        status: 400,
        body: {
          code: 'invalid',
          error: 'Use an MP3, WAV, M4A, AIFF or FLAC file.',
          fieldErrors: { file: 'Unsupported file type.' },
        },
      },
    });
    const { states, done } = run(server, [item('a', 12)]);
    await done;
    expect(states.get('a')).toMatchObject({
      status: 'error',
      error: 'Use an MP3, WAV, M4A, AIFF or FLAC file.',
      fieldErrors: { file: 'Unsupported file type.' },
    });
    expect(server.log.filter((l) => l === 'POST /api/uploads')).toHaveLength(1);
    expect(server.delays).toEqual([]);
  });

  it('does not retry a permission failure', async () => {
    const server = makeServer({
      startError: { status: 403, body: { error: 'You do not have permission to do that.' } },
    });
    const { states, done } = run(server, [item('a', 12)]);
    await done;
    expect(states.get('a')).toMatchObject({
      status: 'error',
      error: 'You do not have permission to do that.',
    });
    expect(server.log).toHaveLength(1);
  });

  it('re-sends only the parts the server says are missing, then completes', async () => {
    const server = makeServer({ loseParts: [2, 3] });
    const { states, done } = run(server, [item('a', 35)], { partConcurrency: 1 });
    await done;
    expect(states.get('a')).toMatchObject({ status: 'done', sentBytes: 35 });
    expect([...server.puts].sort()).toEqual([1, 2, 2, 3, 3, 4]);
    expect(server.log.filter((l) => l.endsWith('/complete'))).toHaveLength(2);
  });

  it('cancels: stops sending, tells the server to discard the upload, and reports cancelled', async () => {
    const server = makeServer();
    const original = server.deps.putPart;
    const ref: { manager?: UploadManager } = {};
    server.deps.putPart = async (...args) => {
      await ref.manager!.cancel('a', 'u1');
      return original(...args);
    };
    const states = new Map<string, ItemState>();
    ref.manager = new UploadManager(server.deps, (id, s) => states.set(id, s), {
      partConcurrency: 1,
    });
    await ref.manager.run([item('a', 35)]);
    expect(states.get('a')?.status).toBe('cancelled');
    expect(server.log).toContain('DELETE /api/uploads/u1');
    expect(server.log.some((l) => l.endsWith('/complete'))).toBe(false);
  });

  it('uploads a couple of files at once and no more', async () => {
    const server = makeServer();
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, 12));
    const { states, done } = run(server, items, { fileConcurrency: 2 });
    await done;
    expect([...states.values()].every((s) => s.status === 'done')).toBe(true);
    expect(server.maxConcurrentStarts).toBeLessThanOrEqual(2);
  });

  it('carries on with the other files when one fails', async () => {
    const server = makeServer();
    const original = server.deps.request;
    server.deps.request = async (m, p, b) =>
      m === 'POST' && p === '/api/uploads' && (b as { filename: string }).filename === 'bad.wav'
        ? { status: 400, body: { error: 'nope' } }
        : original(m, p, b);
    const { states, done } = run(server, [item('a', 12), item('b', 12, 'bad.wav'), item('c', 12)]);
    await done;
    expect(states.get('a')?.status).toBe('done');
    expect(states.get('b')?.status).toBe('error');
    expect(states.get('c')?.status).toBe('done');
  });
});
