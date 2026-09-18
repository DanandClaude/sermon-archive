import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  assertValidKey,
  InvalidPartsError,
  MIN_PART_BYTES,
  UploadNotFoundError,
  type UploadedPart,
  type UploadStore,
} from './types';

type Options = { minPartBytes?: number; secret?: string };

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');

/**
 * Local-disk stand-in for S3 multipart uploads. "Presigned" part URLs point at the app's own
 * /api/dev-uploads route and are HMAC-signed and time-limited, like the real thing. Nothing
 * leaves this machine.
 */
export class FakeUploadStore implements UploadStore {
  readonly kind = 'fake';
  private readonly minPartBytes: number;
  private readonly secret: string;

  constructor(
    private readonly root: string,
    options: Options = {},
  ) {
    this.minPartBytes = options.minPartBytes ?? MIN_PART_BYTES;
    this.secret = options.secret ?? randomBytes(32).toString('hex');
  }

  private uploadDir(uploadId: string) {
    return join(this.root, 'multipart', uploadId.replace(/[^a-zA-Z0-9-]/g, ''));
  }
  private objectPath(key: string) {
    assertValidKey(key);
    return join(this.root, 'objects', key);
  }
  private async requireUpload(uploadId: string): Promise<{ key: string }> {
    try {
      return JSON.parse(await readFile(join(this.uploadDir(uploadId), 'meta.json'), 'utf8'));
    } catch {
      throw new UploadNotFoundError(uploadId);
    }
  }
  private sign(uploadId: string, partNumber: number, exp: number) {
    return createHmac('sha256', this.secret)
      .update(`${uploadId}.${partNumber}.${exp}`)
      .digest('hex');
  }

  async createMultipartUpload({ key }: { key: string; contentType: string }) {
    assertValidKey(key);
    const uploadId = randomUUID();
    await mkdir(this.uploadDir(uploadId), { recursive: true });
    await writeFile(join(this.uploadDir(uploadId), 'meta.json'), JSON.stringify({ key }));
    return { uploadId };
  }

  async presignPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSec: number;
  }) {
    await this.requireUpload(input.uploadId);
    const exp = Math.floor(Date.now() / 1000) + input.expiresInSec;
    const sig = this.sign(input.uploadId, input.partNumber, exp);
    return { url: `/api/dev-uploads/${input.uploadId}/${input.partNumber}?exp=${exp}&sig=${sig}` };
  }

  /** What the /api/dev-uploads route calls when the browser PUTs a part. Returns the part's ETag. */
  async receivePart(input: {
    uploadId: string;
    partNumber: number;
    exp: number;
    sig: string;
    body: Uint8Array;
  }): Promise<{ etag: string }> {
    const expected = Buffer.from(this.sign(input.uploadId, input.partNumber, input.exp));
    const given = Buffer.from(input.sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new Error('Bad signature');
    }
    if (input.exp < Date.now() / 1000) throw new Error('URL expired');
    await this.requireUpload(input.uploadId);
    await writeFile(join(this.uploadDir(input.uploadId), String(input.partNumber)), input.body);
    return { etag: md5(input.body) };
  }

  async listParts({ uploadId }: { key: string; uploadId: string }): Promise<UploadedPart[]> {
    await this.requireUpload(uploadId);
    const dir = this.uploadDir(uploadId);
    const parts: UploadedPart[] = [];
    for (const name of await readdir(dir)) {
      if (!/^\d+$/.test(name)) continue;
      const bytes = await readFile(join(dir, name));
      parts.push({ partNumber: Number(name), etag: md5(bytes), size: bytes.byteLength });
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }) {
    const { key } = await this.requireUpload(input.uploadId);
    const have = await this.listParts(input);
    const wanted = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
    if (wanted.length === 0) throw new InvalidPartsError('No parts to complete.');
    wanted.forEach((part, i) => {
      const found = have.find((p) => p.partNumber === part.partNumber);
      if (part.partNumber !== i + 1)
        throw new InvalidPartsError('Parts must be numbered from 1 with no gaps.');
      if (!found || found.etag !== part.etag)
        throw new InvalidPartsError(`Part ${part.partNumber} is missing or does not match.`);
      if (i < wanted.length - 1 && found.size < this.minPartBytes) {
        throw new InvalidPartsError(
          `Part ${part.partNumber} is smaller than the minimum part size.`,
        );
      }
    });

    const target = this.objectPath(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, new Uint8Array(0));
    let bytes = 0;
    for (const part of wanted) {
      const data = await readFile(join(this.uploadDir(input.uploadId), String(part.partNumber)));
      await writeFile(target, data, { flag: 'a' });
      bytes += data.byteLength;
    }
    await rm(this.uploadDir(input.uploadId), { recursive: true, force: true });
    return { bytes };
  }

  async abortMultipartUpload({ uploadId }: { key: string; uploadId: string }) {
    await rm(this.uploadDir(uploadId), { recursive: true, force: true });
  }

  async head(key: string) {
    try {
      return { bytes: (await stat(this.objectPath(key))).size };
    } catch {
      return null;
    }
  }

  async read(key: string, range?: { start: number; end: number }) {
    const path = this.objectPath(key);
    await stat(path);
    return createReadStream(path, range) as AsyncIterable<Uint8Array>;
  }
}
