export type ChecksumAlgorithm =
  'md5' | 'sha1' | 'sha256' | 'quickxor' | 'dropbox-content-hash' | 's3-etag';

export type StoredObject = {
  remoteId: string;
  /** Provider-neutral, slash-separated, relative to the target's root folder. */
  path: string;
  bytes: number;
  /** As reported by the provider, in `checksumAlgorithm`. */
  checksum: string;
  checksumAlgorithm: ChecksumAlgorithm;
};

export type PutInput = {
  path: string;
  contentType: string;
  body: Uint8Array | AsyncIterable<Uint8Array>;
};

/**
 * Where approved sermons are filed. Google Drive is first; S3, OneDrive and Dropbox should
 * be able to slot in without changing the filing job. Providers report different checksums
 * (Drive MD5, OneDrive QuickXor, Dropbox a block hash), so the filing job hashes with
 * `checksumAlgorithm` while streaming and also keeps its own SHA-256.
 *
 * There is deliberately no overwrite or delete: originals are immutable. Deletion is an
 * admin-only flow that gets added when it is built.
 */
export interface StorageProvider {
  readonly kind: string;
  readonly checksumAlgorithm: ChecksumAlgorithm;
  /** Create-only. Throws ObjectExistsError if the path is taken. */
  put(input: PutInput): Promise<StoredObject>;
  stat(path: string): Promise<StoredObject | null>;
  /** Throws ObjectNotFoundError. */
  read(path: string): Promise<AsyncIterable<Uint8Array>>;
  list(prefix: string): Promise<StoredObject[]>;
}

export class ObjectExistsError extends Error {
  constructor(path: string) {
    super(`Object already exists: ${path}`);
    this.name = 'ObjectExistsError';
  }
}

export class ObjectNotFoundError extends Error {
  constructor(path: string) {
    super(`Object not found: ${path}`);
    this.name = 'ObjectNotFoundError';
  }
}

export class InvalidPathError extends Error {
  constructor(path: string) {
    super(`Invalid storage path: ${JSON.stringify(path)}`);
    this.name = 'InvalidPathError';
  }
}

/** No leading slash, backslashes, empty segments or dot segments. */
export function assertValidPath(path: string): void {
  const segments = path.split('/');
  const bad =
    path === '' || path.includes('\\') || segments.some((s) => s === '' || s === '.' || s === '..');
  if (bad) throw new InvalidPathError(path);
}
