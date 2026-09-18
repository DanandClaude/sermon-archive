/**
 * The browser side of uploading. Kept free of DOM and network code (both are injected) so the
 * retry, resume and cancel behaviour can be tested without a browser.
 */

export type UploadDetails = {
  recordedOn?: string;
  labelScripture?: string;
  speaker?: string;
  batchLabel?: string;
  side?: 'A' | 'B' | null;
};

export type UploadableFile = {
  name: string;
  size: number;
  lastModified: number;
  slice(start: number, end: number): { size: number };
};

export type UploadItem = { id: string; file: UploadableFile; details: UploadDetails };

export type ItemStatus =
  'waiting' | 'starting' | 'uploading' | 'finishing' | 'done' | 'error' | 'cancelled';

export type ItemState = {
  status: ItemStatus;
  sentBytes: number;
  totalBytes: number;
  uploadId?: string;
  sermonId?: string;
  resumed?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
export class NetworkError extends Error {
  constructor(message = 'The connection was interrupted.') {
    super(message);
    this.name = 'NetworkError';
  }
}
/** A presigned part URL was refused, usually because it expired. Retried with a fresh one. */
export class LinkExpiredError extends Error {
  constructor() {
    super('The upload link expired.');
    this.name = 'LinkExpiredError';
  }
}
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export type UploaderDeps = {
  /** Calls the app's own API. Must throw NetworkError if the request could not be made. */
  request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** PUTs one part to its presigned URL. Throws HttpError, NetworkError or CancelledError. */
  putPart: (
    url: string,
    body: { size: number },
    onProgress: (sentBytes: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export type UploaderOptions = {
  fileConcurrency?: number;
  partConcurrency?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
};

type StartResponse = {
  uploadId: string;
  sermonId: string;
  partSize: number;
  totalParts: number;
  completedParts: { partNumber: number; size: number }[];
  resumed: boolean;
};

function retryable(error: unknown): boolean {
  if (error instanceof NetworkError || error instanceof LinkExpiredError) return true;
  // A 403 from the app's own API means "not allowed" and is never retried.
  if (error instanceof HttpError) return error.status >= 500 || [408, 429].includes(error.status);
  return false;
}

export class UploadManager {
  private readonly options: Required<UploaderOptions>;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly deps: UploaderDeps,
    private readonly onChange: (id: string, state: ItemState) => void,
    options: UploaderOptions = {},
  ) {
    this.options = {
      fileConcurrency: options.fileConcurrency ?? 2,
      partConcurrency: options.partConcurrency ?? 3,
      maxAttempts: options.maxAttempts ?? 4,
      baseDelayMs: options.baseDelayMs ?? 800,
    };
  }

  /** Uploads every item, a couple of files at a time. Resolves when all have finished or failed. */
  async run(items: UploadItem[]): Promise<void> {
    for (const item of items) {
      this.onChange(item.id, { status: 'waiting', sentBytes: 0, totalBytes: item.file.size });
    }
    const queue = [...items];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await this.uploadOne(item);
    };
    await Promise.all(
      Array.from({ length: Math.min(this.options.fileConcurrency, items.length) }, worker),
    );
  }

  /** Stops an upload and asks the server to discard it. Finished uploads are left alone. */
  async cancel(id: string, uploadId?: string): Promise<void> {
    this.cancelled.add(id);
    this.controllers.get(id)?.abort();
    if (uploadId) {
      try {
        await this.deps.request('DELETE', `/api/uploads/${uploadId}`);
      } catch {
        // Best effort: an abandoned upload is cleaned up by the storage lifecycle rule.
      }
    }
  }

  private async withRetry<T>(id: string, attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      if (this.cancelled.has(id)) throw new CancelledError();
      try {
        return await attempt();
      } catch (error) {
        if (!retryable(error) || n >= this.options.maxAttempts) throw error;
        await this.deps.sleep(this.options.baseDelayMs * 2 ** (n - 1));
      }
    }
  }

  private async call(id: string, method: string, path: string, body?: unknown) {
    const res = await this.withRetry(id, async () => {
      const r = await this.deps.request(method, path, body);
      if (r.status >= 400) {
        throw new HttpError(r.status, String(r.body.error ?? 'Request failed'), r.body);
      }
      return r;
    });
    return res.body;
  }

  private async uploadOne(item: UploadItem): Promise<void> {
    const { id, file } = item;
    const state: ItemState = { status: 'starting', sentBytes: 0, totalBytes: file.size };
    const emit = (patch: Partial<ItemState>) => {
      Object.assign(state, patch);
      this.onChange(id, { ...state });
    };
    const controller = new AbortController();
    this.controllers.set(id, controller);

    try {
      if (this.cancelled.has(id)) throw new CancelledError();
      emit({});
      const start = (await this.call(id, 'POST', '/api/uploads', {
        filename: file.name,
        sizeBytes: file.size,
        lastModified: file.lastModified,
        details: item.details,
      })) as unknown as StartResponse;
      emit({
        uploadId: start.uploadId,
        sermonId: start.sermonId,
        resumed: start.resumed,
        status: 'uploading',
      });

      const done = new Set(start.completedParts.map((p) => p.partNumber));
      const sizeOf = (n: number) =>
        n < start.totalParts ? start.partSize : file.size - start.partSize * (start.totalParts - 1);
      let completedBytes = [...done].reduce((sum, n) => sum + sizeOf(n), 0);
      const inFlight = new Map<number, number>();
      const report = () =>
        emit({ sentBytes: completedBytes + [...inFlight.values()].reduce((a, b) => a + b, 0) });
      report();

      const sendParts = async (parts: number[]) => {
        const pending = [...parts];
        const worker = async () => {
          for (let n = pending.shift(); n !== undefined; n = pending.shift()) {
            await this.withRetry(id, async () => {
              const { url } = (await this.call(id, 'POST', `/api/uploads/${start.uploadId}/parts`, {
                partNumber: n,
              })) as { url: string };
              const from = (n - 1) * start.partSize;
              const blob = file.slice(from, from + sizeOf(n));
              inFlight.set(n, 0);
              try {
                await this.deps.putPart(
                  url,
                  blob,
                  (sent) => (inFlight.set(n, sent), report()),
                  controller.signal,
                );
              } catch (error) {
                inFlight.delete(n);
                report();
                if (error instanceof HttpError && error.status === 403)
                  throw new LinkExpiredError();
                throw error;
              }
              // Move the bytes from "in flight" to "completed" in one step so progress never dips.
              completedBytes += sizeOf(n);
              done.add(n);
              inFlight.delete(n);
              report();
            });
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(this.options.partConcurrency, parts.length) }, worker),
        );
      };

      const all = Array.from({ length: start.totalParts }, (_, i) => i + 1);
      await sendParts(all.filter((n) => !done.has(n)));

      emit({ status: 'finishing' });
      for (let round = 1; ; round++) {
        try {
          await this.call(id, 'POST', `/api/uploads/${start.uploadId}/complete`);
          break;
        } catch (error) {
          const missing =
            error instanceof HttpError
              ? (error.body?.missingParts as number[] | undefined)
              : undefined;
          if (
            !(error instanceof HttpError) ||
            error.status !== 409 ||
            !missing?.length ||
            round >= 3
          )
            throw error;
          // The server says some parts didn't land: send just those again.
          for (const n of missing) {
            if (done.delete(n)) completedBytes -= sizeOf(n);
          }
          emit({ status: 'uploading' });
          await sendParts(missing);
          emit({ status: 'finishing' });
        }
      }
      emit({ status: 'done', sentBytes: file.size });
    } catch (error) {
      if (error instanceof CancelledError || this.cancelled.has(id)) {
        emit({ status: 'cancelled' });
      } else if (error instanceof HttpError) {
        emit({
          status: 'error',
          error: error.message,
          fieldErrors: error.body?.fieldErrors as Record<string, string> | undefined,
        });
      } else {
        emit({
          status: 'error',
          error: 'The connection kept dropping. Add the file again to continue where it stopped.',
        });
      }
    } finally {
      this.controllers.delete(id);
    }
  }
}
