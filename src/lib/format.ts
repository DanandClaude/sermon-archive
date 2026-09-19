const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '1988-03-13' → 'Mar 13, 1988'. Built from the text, never a Date, so time zones can't shift the day. */
export function formatRecordedOn(iso: string | null): string | null {
  const match = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

/** 'just now', '5 minutes ago', '3 hours ago', '2 days ago'. */
export function timeAgo(then: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (seconds < 3600) return plural(Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return plural(Math.floor(seconds / 3600), 'hour');
  return plural(Math.floor(seconds / 86400), 'day');
}

/** 83 → '1:23', 3725 → '1:02:05'. For playback positions. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Reads a time someone typed: 83, 1:23 or 1:02:05, with seconds optionally fractional.
 * Returns seconds, or null if it isn't a time.
 */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((n) => n >= 60)) return null;
  return numbers.reduce((total, n) => total * 60 + n, 0);
}
