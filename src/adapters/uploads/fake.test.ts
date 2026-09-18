import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putPart, tempStore } from '../../../tests/support/uploads';
import type { FakeUploadStore } from './fake';
import { InvalidPartsError, InvalidStorageKeyError, UploadNotFoundError } from './types';

let store: FakeUploadStore;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ store, cleanup } = await tempStore(4)));
afterEach(() => cleanup());

const KEY = 'originals/a/original.wav';
const text = (s: string) => new TextEncoder().encode(s);
const start = () => store.createMultipartUpload({ key: KEY, contentType: 'audio/wav' });

async function upload(uploadId: string, n: number, body: Uint8Array) {
  const { url } = await store.presignPart({ key: KEY, uploadId, partNumber: n, expiresInSec: 60 });
  return putPart(store, url, body);
}
async function readAll(key: string, range?: { start: number; end: number }) {
  const chunks: Uint8Array[] = [];
  for await (const c of await store.read(key, range)) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

describe('FakeUploadStore multipart lifecycle', () => {
  it('assembles parts in order into one object', async () => {
    const { uploadId } = await start();
    const e2 = await upload(uploadId, 2, text('world!'));
    const e1 = await upload(uploadId, 1, text('hello '));
    expect((await store.listParts({ key: KEY, uploadId })).map((p) => p.partNumber)).toEqual([
      1, 2,
    ]);
    const parts = [
      { partNumber: 2, etag: e2.etag },
      { partNumber: 1, etag: e1.etag },
    ];
    expect(await store.completeMultipartUpload({ key: KEY, uploadId, parts })).toEqual({
      bytes: 12,
    });
    expect(await readAll(KEY)).toBe('hello world!');
    expect(await store.head(KEY)).toEqual({ bytes: 12 });
  });

  it('reads a byte range', async () => {
    const { uploadId } = await start();
    const e = await upload(uploadId, 1, text('0123456789'));
    await store.completeMultipartUpload({
      key: KEY,
      uploadId,
      parts: [{ partNumber: 1, etag: e.etag }],
    });
    expect(await readAll(KEY, { start: 2, end: 4 })).toBe('234');
  });

  it('re-uploading a part replaces it, so a retry is safe', async () => {
    const { uploadId } = await start();
    await upload(uploadId, 1, text('aaaa'));
    const again = await upload(uploadId, 1, text('bbbb'));
    const parts = await store.listParts({ key: KEY, uploadId });
    expect(parts).toHaveLength(1);
    expect(parts[0].etag).toBe(again.etag);
  });

  it('refuses to complete with a gap, a wrong ETag, or an undersized non-final part', async () => {
    const { uploadId } = await start();
    const e1 = await upload(uploadId, 1, text('ab'));
    const e2 = await upload(uploadId, 2, text('cdef'));
    const complete = (parts: { partNumber: number; etag: string }[]) =>
      store.completeMultipartUpload({ key: KEY, uploadId, parts });
    await expect(complete([{ partNumber: 2, etag: e2.etag }])).rejects.toBeInstanceOf(
      InvalidPartsError,
    );
    await expect(
      complete([
        { partNumber: 1, etag: 'wrong' },
        { partNumber: 2, etag: e2.etag },
      ]),
    ).rejects.toBeInstanceOf(InvalidPartsError);
    await expect(
      complete([
        { partNumber: 1, etag: e1.etag },
        { partNumber: 2, etag: e2.etag },
      ]),
    ).rejects.toThrow(/minimum part size/);
  });

  it('abort removes the upload and is idempotent', async () => {
    const { uploadId } = await start();
    await store.abortMultipartUpload({ key: KEY, uploadId });
    await store.abortMultipartUpload({ key: KEY, uploadId });
    await expect(store.listParts({ key: KEY, uploadId })).rejects.toBeInstanceOf(
      UploadNotFoundError,
    );
  });

  it('reports a missing object as null', async () => {
    expect(await store.head('originals/none/original.wav')).toBeNull();
  });

  it.each(['../x', '/x', 'a//b', ''])('rejects the unsafe key %j', async (key) => {
    await expect(store.createMultipartUpload({ key, contentType: 'x' })).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
  });
});

describe('presigned part URLs', () => {
  it('reject a tampered signature, another part number, or an expired URL', async () => {
    const { uploadId } = await start();
    const { url } = await store.presignPart({
      key: KEY,
      uploadId,
      partNumber: 1,
      expiresInSec: 60,
    });
    const parsed = new URL(url, 'http://x');
    const base = {
      uploadId,
      exp: Number(parsed.searchParams.get('exp')),
      sig: parsed.searchParams.get('sig')!,
      body: text('abcd'),
    };
    const flipped = base.sig.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    await expect(store.receivePart({ ...base, partNumber: 1, sig: flipped })).rejects.toThrow(
      /signature/i,
    );
    await expect(store.receivePart({ ...base, partNumber: 2 })).rejects.toThrow(/signature/i);

    const expired = await store.presignPart({
      key: KEY,
      uploadId,
      partNumber: 1,
      expiresInSec: -10,
    });
    const e = new URL(expired.url, 'http://x');
    await expect(
      store.receivePart({
        uploadId,
        partNumber: 1,
        exp: Number(e.searchParams.get('exp')),
        sig: e.searchParams.get('sig')!,
        body: text('abcd'),
      }),
    ).rejects.toThrow(/expired/i);

    await expect(store.receivePart({ ...base, partNumber: 1 })).resolves.toBeTruthy();
  });

  it('cannot be minted for an upload that does not exist', async () => {
    await expect(
      store.presignPart({ key: KEY, uploadId: 'nope', partNumber: 1, expiresInSec: 60 }),
    ).rejects.toBeInstanceOf(UploadNotFoundError);
  });
});
