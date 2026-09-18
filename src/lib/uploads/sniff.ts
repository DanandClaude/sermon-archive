export type AudioFormat = 'mp3' | 'wav' | 'm4a' | 'aiff' | 'flac';

export const EXTENSION_FORMAT: Record<string, AudioFormat> = {
  mp3: 'mp3',
  wav: 'wav',
  m4a: 'm4a',
  aiff: 'aiff',
  aif: 'aiff',
  flac: 'flac',
};

export const FORMAT_MIME: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aiff: 'audio/aiff',
  flac: 'audio/flac',
};

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** Identifies an audio file from its first bytes, so a renamed non-audio file is rejected. */
export function sniffAudioFormat(bytes: Uint8Array): AudioFormat | null {
  if (bytes.length < 4) return null;
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE')
    return 'wav';
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'FORM' &&
    ['AIFF', 'AIFC'].includes(ascii(bytes, 8, 4))
  ) {
    return 'aiff';
  }
  if (bytes.length >= 8 && ascii(bytes, 4, 4) === 'ftyp') return 'm4a';
  return null;
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}
