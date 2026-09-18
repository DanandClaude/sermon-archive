import { CancelledError, HttpError, NetworkError, type UploaderDeps } from './client';

/** The real network for UploadManager: fetch for the app's API, XHR for part PUTs (it reports progress). */
export const browserDeps: UploaderDeps = {
  async request(method, path, body) {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NetworkError();
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = response.status === 204 ? {} : await response.json();
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  },

  putPart(url, body, onProgress, signal) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = (event) => onProgress(event.loaded);
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new HttpError(xhr.status, 'Part upload failed'));
      xhr.onerror = () => reject(new NetworkError());
      xhr.onabort = () => reject(new CancelledError());
      if (signal.aborted) return reject(new CancelledError());
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(body as Blob);
    });
  },

  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
