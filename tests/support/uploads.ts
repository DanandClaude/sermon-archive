import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeUploadStore } from '@/adapters/uploads/fake';

export async function tempStore(minPartBytes = 1) {
  const root = await mkdtemp(join(tmpdir(), 'sermon-uploads-'));
  return {
    store: new FakeUploadStore(root, { minPartBytes }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Plays the browser's part: PUTs bytes to a fake presigned URL. Returns the part's ETag. */
export async function putPart(store: FakeUploadStore, url: string, body: Uint8Array) {
  const parsed = new URL(url, 'http://localhost');
  const [, , , uploadId, partNumber] = parsed.pathname.split('/');
  return store.receivePart({
    uploadId,
    partNumber: Number(partNumber),
    exp: Number(parsed.searchParams.get('exp')),
    sig: parsed.searchParams.get('sig')!,
    body,
  });
}

/** A file that starts like a WAV, padded to `length` bytes. */
export function wavBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WAVE'), 8);
  for (let i = 12; i < length; i++) bytes[i] = i % 251;
  return bytes;
}
