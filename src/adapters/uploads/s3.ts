import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  NoSuchUpload,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertValidKey, UploadNotFoundError, type UploadedPart, type UploadStore } from './types';

type Config = { bucket: string; region: string; endpoint?: string; client?: S3Client };

/**
 * AWS S3 or any S3-compatible service (Cloudflare R2, Backblaze B2, MinIO). Credentials come
 * from the standard AWS environment variables or an instance role.
 *
 * The bucket needs a CORS rule that allows PUT from APP_URL, and a lifecycle rule that aborts
 * incomplete multipart uploads after a few days so abandoned uploads don't accumulate.
 */
export class S3UploadStore implements UploadStore {
  readonly kind = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: Config) {
    this.bucket = config.bucket;
    this.client =
      config.client ??
      new S3Client({
        region: config.region,
        ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
      });
  }

  private gone(uploadId: string, error: unknown): never {
    if (error instanceof NoSuchUpload || (error as { name?: string })?.name === 'NoSuchUpload') {
      throw new UploadNotFoundError(uploadId);
    }
    throw error;
  }

  async createMultipartUpload({ key, contentType }: { key: string; contentType: string }) {
    assertValidKey(key);
    const out = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!out.UploadId) throw new Error('S3 did not return an upload id.');
    return { uploadId: out.UploadId };
  }

  async presignPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSec: number;
  }) {
    assertValidKey(input.key);
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
      }),
      { expiresIn: input.expiresInSec },
    );
    return { url };
  }

  async presignRead({ key, expiresInSec }: { key: string; expiresInSec: number }) {
    assertValidKey(key);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn: expiresInSec,
      },
    );
    return { url };
  }

  async listParts({ key, uploadId }: { key: string; uploadId: string }): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    try {
      do {
        const out = await this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const p of out.Parts ?? []) {
          parts.push({ partNumber: p.PartNumber!, etag: p.ETag!, size: p.Size ?? 0 });
        }
        marker = out.IsTruncated ? String(out.NextPartNumberMarker) : undefined;
      } while (marker);
    } catch (error) {
      return this.gone(uploadId, error);
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }) {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          MultipartUpload: {
            Parts: input.parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    } catch (error) {
      return this.gone(input.uploadId, error);
    }
    const head = await this.head(input.key);
    if (!head) throw new Error('Upload completed but the object was not found.');
    return head;
  }

  async abortMultipartUpload({ key, uploadId }: { key: string; uploadId: string }) {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      if (!(error instanceof NoSuchUpload) && (error as { name?: string })?.name !== 'NoSuchUpload')
        throw error;
    }
  }

  async head(key: string) {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: out.ContentLength ?? 0 };
    } catch (error) {
      if ((error as { name?: string })?.name === 'NotFound') return null;
      throw error;
    }
  }

  async read(key: string, range?: { start: number; end: number }) {
    const out = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    return out.Body as unknown as AsyncIterable<Uint8Array>;
  }
}
