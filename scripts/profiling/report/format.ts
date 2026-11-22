// Every number of the report, formatted on en-US: values by kind, signed differences with a true minus sign.
import type { FigureKind } from '../figures.ts';

const LOCALE = 'en-US';
const formatters = new Map<number, Intl.NumberFormat>();
const nf = (digits: number): Intl.NumberFormat => {
  let f = formatters.get(digits);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    formatters.set(digits, f);
  }
  return f;
};

/** A plain number, `digits` decimals (non-finite values print as an em dash). */
export const num = (x: number, digits = 0): string => (Number.isFinite(x) ? nf(digits).format(x) : '—');
export const pct = (x: number, digits = 1): string => `${num(x, digits)}%`;

export function ms(x: number): string {
  const abs = Math.abs(x);
  return `${num(x, abs < 10 ? 2 : abs < 100 ? 1 : 0)} ms`;
}

export function bytes(x: number): string {
  const abs = Math.abs(x);
  if (abs < 1024) return `${num(x)} B`;
  if (abs < 1024 * 1024) return `${num(x / 1024, abs < 10 * 1024 ? 1 : 0)} KiB`;
  if (abs < 1024 ** 3) return `${num(x / 1024 / 1024, 1)} MiB`;
  return `${num(x / 1024 ** 3, 2)} GiB`;
}

const countDigits = (x: number) => (Number.isInteger(x) ? 0 : Math.abs(x) < 10 ? 2 : 1);

export function value(x: number, kind: FigureKind): string {
  switch (kind) {
    case 'cpu':
    case 'share':
    case 'gpuBusy':
      return pct(x, Math.abs(x) < 1 && x !== 0 ? 2 : 1);
    case 'tps':
      return `${num(x, 1)} tok/s`;
    case 'duration':
      return ms(x);
    case 'size':
      return bytes(x);
    case 'count':
      return num(x, countDigits(x));
  }
}

const MINUS = '−';
const sign = (x: number) => (x < 0 ? MINUS : '+');

/** A difference: points for percentages, the unit of the kind otherwise. */
export function delta(d: number, kind: FigureKind): string {
  const abs = Math.abs(d);
  switch (kind) {
    case 'cpu':
    case 'share':
    case 'gpuBusy':
      return `${sign(d)}${num(abs, 1)} pt`;
    case 'tps':
      return `${sign(d)}${num(abs, 1)} tok/s`;
    case 'duration':
      return `${sign(d)}${ms(abs)}`;
    case 'size':
      return `${sign(d)}${bytes(abs)}`;
    case 'count':
      return `${sign(d)}${num(abs, countDigits(abs))}`;
  }
}

export const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const code = (s: string): string => `<code>${esc(s)}</code>`;
