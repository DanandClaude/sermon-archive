import type { UploadStore } from '@/adapters/uploads/types';

export type Peaks = { duration: number; peaks: number[] };

/** The waveform the worker stored for a recording, or null if it is missing or not what we expect. */
export async function readPeaks(
  store: Pick<UploadStore, 'read'>,
  key: string | null,
): Promise<Peaks | null> {
  if (!key) return null;
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of await store.read(key)) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<Peaks>;
    if (
      typeof value.duration !== 'number' ||
      !Array.isArray(value.peaks) ||
      !value.peaks.every((p) => typeof p === 'number')
    )
      return null;
    return { duration: value.duration, peaks: value.peaks };
  } catch {
    // The waveform is decoration. A missing or damaged file must never break the page.
    return null;
  }
}
