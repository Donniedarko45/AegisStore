import clsx, { type ClassValue } from 'clsx';

export const cx = (...v: ClassValue[]) => clsx(v);

const nf = new Intl.NumberFormat();
const compactNf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const pr = new Intl.PluralRules();

export const formatNumber = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? '—' : nf.format(n));
export const formatCompact = (n: number) => (Math.abs(n) < 10_000 ? nf.format(n) : compactNf.format(n));

/** "1 object" / "1,284 objects" with locale plural rules. */
export const plural = (n: number, one: string, other: string) => `${formatNumber(n)} ${pr.select(n) === 'one' ? one : other}`;

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
/** Split bytes into a display value and unit (used by animated numbers). */
export function bytesParts(n: number, digits = 1): { value: number; unit: string; digits: number } {
  if (!Number.isFinite(n) || n <= 0) return { value: 0, unit: 'B', digits: 0 };
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  const d = i === 0 || v >= 100 ? 0 : digits;
  return { value: Number(v.toFixed(d)), unit: UNITS[i]!, digits: d };
}
export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const { value, unit, digits: d } = bytesParts(n, digits);
  return `${value.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })} ${unit}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'long' });
const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dfShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** "just now", "5 minutes ago", "yesterday"; switches to an absolute date after a week. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.round((t - now) / 1000);
  const a = Math.abs(s);
  if (a < 10) return 'just now';
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 7 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return dfShort.format(t);
}
export const formatDateTime = (iso: string | null | undefined) => (iso ? dtf.format(new Date(iso)) : '—');
export const formatTime = (iso: string | number) => tf.format(new Date(iso));
export const formatDay = (iso: string | number) => dfShort.format(new Date(iso));

/** 3725 -> "1h 2m"; 42 -> "42s" */
export function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const firstGrapheme = (s: string) => (segmenter ? ([...segmenter.segment(s)][0]?.segment ?? '') : (Array.from(s)[0] ?? ''));

/** Grapheme-safe initials: "Ólafur Darri" -> "ÓD", "🦊 Fox" -> "🦊F", email fallback. */
export function initials(name: string | null | undefined, email?: string | null): string {
  const source = (name ?? '').trim() || (email ?? '').split('@')[0] || '?';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const chars = (words.length > 1 ? [words[0]!, words[words.length - 1]!] : [words[0] ?? '?']).map(firstGrapheme);
  return chars.join('').toLocaleUpperCase();
}

/** Stable hue (0-360) for decorative avatars. */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** "a-very-long-file-name.pdf" -> "a-very-lo…name.pdf" (keeps the distinguishing end). */
export function middleTruncate(s: string, max = 48): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const tail = Math.ceil(keep / 2.2);
  return `${s.slice(0, keep - tail)}…${s.slice(-tail)}`;
}

export const humanizeAction = (a: string) => {
  const s = a.replace(/[._]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
