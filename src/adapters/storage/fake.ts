import { createHash } from 'node:crypto';
import {
  assertValidPath,
  ObjectExistsError,
  ObjectNotFoundError,
  type ChecksumAlgorithm,
  type PutInput,
  type StorageProvider,
  type StoredObject,
} from './types';

type NodeHash = 'md5' | 'sha1' | 'sha256';

async function collect(body: PutInput['body']): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * In-memory storage for development and tests. Nothing leaves the process. Defaults to MD5
 * (what Drive reports for binary files) so verification code is exercised against a
 * checksum that is not our own SHA-256.
 */
export class FakeStorageProvider implements StorageProvider {
  readonly kind = 'fake';
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  constructor(readonly checksumAlgorithm: ChecksumAlgorithm = 'md5') {
    if (!['md5', 'sha1', 'sha256'].includes(checksumAlgorithm)) {
      throw new Error(`FakeStorageProvider cannot compute ${checksumAlgorithm}`);
    }
  }

  private describe(path: string): StoredObject {
    const object = this.objects.get(path)!;
    return {
      remoteId: `fake:${path}`,
      path,
      bytes: object.bytes.byteLength,
      checksum: createHash(this.checksumAlgorithm as NodeHash)
        .update(object.bytes)
        .digest('hex'),
      checksumAlgorithm: this.checksumAlgorithm,
    };
  }

  async put(input: PutInput): Promise<StoredObject> {
    assertValidPath(input.path);
    if (this.objects.has(input.path)) throw new ObjectExistsError(input.path);
    const bytes = Uint8Array.from(await collect(input.body));
    this.objects.set(input.path, { bytes, contentType: input.contentType });
    return this.describe(input.path);
  }

  async stat(path: string): Promise<StoredObject | null> {
    assertValidPath(path);
    return this.objects.has(path) ? this.describe(path) : null;
  }

  async read(path: string): Promise<AsyncIterable<Uint8Array>> {
    assertValidPath(path);
    const object = this.objects.get(path);
    if (!object) throw new ObjectNotFoundError(path);
    const bytes = object.bytes;
    return (async function* () {
      yield bytes;
    })();
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const withSlash = prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
    return [...this.objects.keys()]
      .filter((path) => path.startsWith(withSlash))
      .sort()
      .map((path) => this.describe(path));
  }

  /** Test hook: change stored bytes behind the app's back so checksum drift can be detected. */
  simulateDrift(path: string): void {
    const object = this.objects.get(path);
    if (!object) throw new ObjectNotFoundError(path);
    const changed = Uint8Array.from(object.bytes);
    changed[0] = (changed[0] ?? 0) ^ 0xff;
    this.objects.set(path, { ...object, bytes: changed });
  }
}
