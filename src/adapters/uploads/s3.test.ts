import { NoSuchUpload, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { S3UploadStore } from './s3';
import { InvalidStorageKeyError, UploadNotFoundError } from './types';

// These check what can be checked without a live bucket: the shape of the signed URLs we hand
// to browsers, and how S3's errors are translated. Behaviour against real S3 needs a test bucket.
const client = (endpoint?: string) =>
  new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: Boolean(endpoint),
    credentials: { accessKeyId: 'AKIATESTTESTTESTTEST', secretAccessKey: 'test-secret-key' },
  });

const KEY = 'originals/abc/original.wav';

describe('S3UploadStore presigned part URLs', () => {
  it('are signed, expire when asked, and name the bucket, key, upload and part', async () => {
    const store = new S3UploadStore({
      bucket: 'church-sermons',
      region: 'us-east-1',
      client: client(),
    });
    const { url } = await store.presignPart({
      key: KEY,
      uploadId: 'up-1',
      partNumber: 3,
      expiresInSec: 900,
    });
    const u = new URL(url);
    expect(u.protocol).toBe('https:');
    expect(u.hostname).toBe('church-sermons.s3.us-east-1.amazonaws.com');
    expect(u.pathname).toBe(`/${KEY}`);
    expect(u.searchParams.get('partNumber')).toBe('3');
    expect(u.searchParams.get('uploadId')).toBe('up-1');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('use path-style addressing for S3-compatible services with a custom endpoint', async () => {
    const store = new S3UploadStore({
      bucket: 'church-sermons',
      region: 'auto',
      endpoint: 'https://storage.example.test',
      client: client('https://storage.example.test'),
    });
    const { url } = await store.presignPart({
      key: KEY,
      uploadId: 'up-1',
      partNumber: 1,
      expiresInSec: 60,
    });
    const u = new URL(url);
    expect(u.hostname).toBe('storage.example.test');
    expect(u.pathname).toBe(`/church-sermons/${KEY}`);
  });

  it('refuse an unsafe key before signing anything', async () => {
    const store = new S3UploadStore({ bucket: 'b', region: 'us-east-1', client: client() });
    await expect(
      store.presignPart({ key: '../secrets', uploadId: 'u', partNumber: 1, expiresInSec: 60 }),
    ).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(
      store.createMultipartUpload({ key: '/abs', contentType: 'audio/wav' }),
    ).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });
});

describe('S3UploadStore error handling', () => {
  const noSuchUpload = () => new NoSuchUpload({ message: 'gone', $metadata: {} });

  it('reports an expired upload as UploadNotFoundError when listing parts', async () => {
    const c = client();
    vi.spyOn(c, 'send').mockRejectedValue(noSuchUpload() as never);
    const store = new S3UploadStore({ bucket: 'b', region: 'us-east-1', client: c });
    await expect(store.listParts({ key: KEY, uploadId: 'u' })).rejects.toBeInstanceOf(
      UploadNotFoundError,
    );
  });

  it('treats aborting an already-gone upload as success', async () => {
    const c = client();
    vi.spyOn(c, 'send').mockRejectedValue(noSuchUpload() as never);
    const store = new S3UploadStore({ bucket: 'b', region: 'us-east-1', client: c });
    await expect(store.abortMultipartUpload({ key: KEY, uploadId: 'u' })).resolves.toBeUndefined();
  });

  it('lets other errors through instead of hiding them', async () => {
    const c = client();
    vi.spyOn(c, 'send').mockRejectedValue(new Error('network down') as never);
    const store = new S3UploadStore({ bucket: 'b', region: 'us-east-1', client: c });
    await expect(store.listParts({ key: KEY, uploadId: 'u' })).rejects.toThrow('network down');
    await expect(store.abortMultipartUpload({ key: KEY, uploadId: 'u' })).rejects.toThrow(
      'network down',
    );
  });

  it('collects every page of parts, sorted', async () => {
    const c = client();
    const send = vi
      .spyOn(c, 'send')
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 2, ETag: '"b"', Size: 8 }],
        IsTruncated: true,
        NextPartNumberMarker: '2',
      } as never)
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 1, ETag: '"a"', Size: 8 }],
        IsTruncated: false,
      } as never);
    const store = new S3UploadStore({ bucket: 'b', region: 'us-east-1', client: c });
    expect(await store.listParts({ key: KEY, uploadId: 'u' })).toEqual([
      { partNumber: 1, etag: '"a"', size: 8 },
      { partNumber: 2, etag: '"b"', size: 8 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports a missing object as null from head', async () => {
    const c = client();
    vi.spyOn(c, 'send').mockRejectedValue(
      Object.assign(new Error('nf'), { name: 'NotFound' }) as never,
    );
    const store = new S3UploadStore({ bucket: 'b', region: 'us-east-1', client: c });
    expect(await store.head(KEY)).toBeNull();
  });
});
