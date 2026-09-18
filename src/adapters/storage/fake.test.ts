import { describe, expect, it } from 'vitest';
import { runStorageProviderContract } from '../../../tests/contracts/storage';
import { FakeStorageProvider } from './fake';

runStorageProviderContract('FakeStorageProvider (md5)', () => new FakeStorageProvider('md5'));
runStorageProviderContract('FakeStorageProvider (sha256)', () => new FakeStorageProvider('sha256'));

describe('FakeStorageProvider', () => {
  it('reports a changed checksum after simulated drift', async () => {
    const provider = new FakeStorageProvider();
    const stored = await provider.put({
      path: 'a.mp3',
      contentType: 'audio/mpeg',
      body: new TextEncoder().encode('abc'),
    });
    provider.simulateDrift('a.mp3');
    expect((await provider.stat('a.mp3'))?.checksum).not.toBe(stored.checksum);
  });

  it('refuses checksum algorithms it cannot compute', () => {
    expect(() => new FakeStorageProvider('quickxor')).toThrow(/cannot compute/);
  });
});
