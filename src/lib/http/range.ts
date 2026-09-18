export type ByteRange = { start: number; end: number };

/**
 * Reads a single "bytes=start-end" Range header. Returns null when there is none (send the whole
 * file), or 'invalid' when it can't be satisfied (answer 416). Audio players seek with these.
 */
export function parseRange(header: string | null, size: number): ByteRange | 'invalid' | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (match[1] === '') {
    // "bytes=-500": the last 500 bytes
    const length = Number(match[2]);
    if (length === 0) return 'invalid';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}
