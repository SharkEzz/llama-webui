import { LOCALE } from '@llama-webui/shared';

export { LOCALE };

const numCache = new Map<string, Intl.NumberFormat>();
/** Cached number formatter: `max` fraction digits at most, `min` at least (defaults to `max`). */
export function num(max: number, min = max): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = numCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: max, minimumFractionDigits: min });
    numCache.set(key, f);
  }
  return f;
}

/** Number with up to `max` decimals: `fmt(3.14159, 1)` → “3.1”, `fmt(3, 1)` → “3”. */
export const fmt = (v: number, max = 1) => num(max, 0).format(v);

/** English plural: `plural(1, 'line')` → “line”, `plural(0, 'line')` → “lines”. */
export const plural = (n: number, one: string, other = `${one}s`) => (n === 1 ? one : other);

/** Readable duration: “45 s”, “12 min 05 s”, “3 h 07 min”, “2 d 4 h”. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${pad(m)} min`;
  if (m > 0) return `${m} min ${pad(sec)} s`;
  return `${sec} s`;
}

const nf = (digits: number) => num(digits);
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** Bytes: “12.3 GiB” (base 1024). */
export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${nf(i === 0 ? 0 : digits).format(Math.sign(n) * v)} ${UNITS[i]}`;
}

/** Byte throughput: “1.2 GiB/s”. */
export const formatBps = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : `${formatBytes(n)}/s`;

/** Token throughput: “42.7 tok/s”. */
export const formatRate = (tps: number | null | undefined) =>
  tps == null || !Number.isFinite(tps) ? '—' : `${nf(1).format(tps)} tok/s`;

/** Percentage: “37%” (one decimal below 10). */
export function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${nf(Math.abs(n) < 10 && n !== 0 ? 1 : 0).format(n)}%`;
}

/** Grouped integer: “32,768”. */
export const formatInt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : nf(0).format(n));

/** Parameter count: “27.3 B”, “600 M”, “—” when unknown. */
export function formatParams(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `${nf(1).format(n / 1e9)} B`;
  if (n >= 1e6) return `${nf(0).format(n / 1e6)} M`;
  return formatInt(n);
}

/** Temperature: “54 °C”. */
export const formatTemp = (c: number | null | undefined) =>
  c == null || !Number.isFinite(c) ? '—' : `${Math.round(c)} °C`;

/** Standard deviation suffix: “ ± 0.4”, empty when zero. */
export const formatStddev = (sd: number) => (sd > 0 ? ` ± ${fmt(sd, 1)}` : '');

const timeFmt = new Intl.DateTimeFormat(LOCALE, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
/** Clock time: “14:03:27”. */
export const formatTime = (t: number | Date) => timeFmt.format(t);

const shortDateFmt = new Intl.DateTimeFormat(LOCALE, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
/** Short date and time: “Nov 7, 14:03”. */
export const formatShortDate = (t: number | Date) => shortDateFmt.format(t);
