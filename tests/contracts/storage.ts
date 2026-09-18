import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InvalidPathError,
  ObjectExistsError,
  ObjectNotFoundError,
  type StorageProvider,
} from '@/adapters/storage/types';

const bytes = (text: string) => new TextEncoder().encode(text);

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Every StorageProvider (fake now, Google Drive, S3, OneDrive, Dropbox later) must pass this. */
export function runStorageProviderContract(name: string, create: () => StorageProvider) {
  describe(`StorageProvider contract: ${name}`, () => {
    it('stores bytes and reports size and a checksum in its declared algorithm', async () => {
      const provider = create();
      const stored = await provider.put({
        path: 'Sermon Archive/1980s/1988/a.mp3',
        contentType: 'audio/mpeg',
        body: bytes('hello'),
      });
      expect(stored.bytes).toBe(5);
      expect(stored.checksumAlgorithm).toBe(provider.checksumAlgorithm);
      if (['md5', 'sha1', 'sha256'].includes(stored.checksumAlgorithm)) {
        const expected = createHash(stored.checksumAlgorithm).update('hello').digest('hex');
        expect(stored.checksum).toBe(expected);
      }
    });

    it('accepts a streamed body', async () => {
      const provider = create();
      await provider.put({
        path: 'streamed.txt',
        contentType: 'text/plain',
        body: (async function* () {
          yield bytes('hel');
          yield bytes('lo');
        })(),
      });
      expect(await readAll(await provider.read('streamed.txt'))).toBe('hello');
    });

    it('never overwrites: a second put to the same path fails and the original is untouched', async () => {
      const provider = create();
      await provider.put({ path: 'original.wav', contentType: 'audio/wav', body: bytes('first') });
      await expect(
        provider.put({ path: 'original.wav', contentType: 'audio/wav', body: bytes('second') }),
      ).rejects.toBeInstanceOf(ObjectExistsError);
      expect(await readAll(await provider.read('original.wav'))).toBe('first');
    });

    it('stat returns the object, or null when it does not exist', async () => {
      const provider = create();
      await provider.put({ path: 'a.txt', contentType: 'text/plain', body: bytes('x') });
      expect((await provider.stat('a.txt'))?.path).toBe('a.txt');
      expect(await provider.stat('missing.txt')).toBeNull();
    });

    it('read throws ObjectNotFoundError for a missing path', async () => {
      await expect(create().read('missing.txt')).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('lists objects under a folder prefix only', async () => {
      const provider = create();
      for (const path of ['1980s/1988/a.mp3', '1980s/1988/a.txt', '1990s/1991/b.mp3']) {
        await provider.put({ path, contentType: 'application/octet-stream', body: bytes(path) });
      }
      expect((await provider.list('1980s')).map((o) => o.path)).toEqual([
        '1980s/1988/a.mp3',
        '1980s/1988/a.txt',
      ]);
      expect(await provider.list('2000s')).toEqual([]);
    });

    it.each(['', '/abs.txt', '../escape.txt', 'a/../b.txt', 'a//b.txt', 'a\\b.txt', './a.txt'])(
      'rejects the unsafe path %j',
      async (path) => {
        await expect(
          create().put({ path, contentType: 'text/plain', body: bytes('x') }),
        ).rejects.toBeInstanceOf(InvalidPathError);
      },
    );
  });
}
