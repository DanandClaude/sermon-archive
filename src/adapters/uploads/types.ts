export type UploadedPart = { partNumber: number; etag: string; size: number };

/**
 * Object storage the browser uploads to directly. The app only mints short-lived per-part URLs;
 * the audio bytes never pass through it. S3 and S3-compatible services implement this for real,
 * and a local-disk fake stands in for development and tests.
 *
 * There is deliberately no delete or overwrite: uploaded originals are immutable.
 */
export interface UploadStore {
  readonly kind: string;
  createMultipartUpload(input: { key: string; contentType: string }): Promise<{ uploadId: string }>;
  /** Throws UploadNotFoundError if the upload no longer exists. */
  presignPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSec: number;
  }): Promise<{ url: string }>;
  /** Parts received so far, in part order. Throws UploadNotFoundError if the upload is gone. */
  listParts(input: { key: string; uploadId: string }): Promise<UploadedPart[]>;
  completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<{ bytes: number }>;
  /** Idempotent. */
  abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void>;
  head(key: string): Promise<{ bytes: number } | null>;
  /** Reads an object, or an inclusive byte range of it. */
  read(key: string, range?: { start: number; end: number }): Promise<AsyncIterable<Uint8Array>>;
}

/** S3 requires every part except the last to be at least 5 MiB. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

export class UploadNotFoundError extends Error {
  constructor(uploadId: string) {
    super(`Upload not found: ${uploadId}`);
    this.name = 'UploadNotFoundError';
  }
}

export class InvalidPartsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPartsError';
  }
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = 'InvalidStorageKeyError';
  }
}

/** No leading slash, backslashes, empty or dot segments. */
export function assertValidKey(key: string): void {
  const bad =
    key === '' ||
    key.includes('\\') ||
    key.split('/').some((s) => s === '' || s === '.' || s === '..');
  if (bad) throw new InvalidStorageKeyError(key);
}
