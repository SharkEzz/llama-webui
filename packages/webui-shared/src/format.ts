/** Locale of every number and date shown to the user, by the UI (`web/src/lib/format.ts`) and the server's messages. */
export const LOCALE = 'en-US';

const intFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

/** An integer with thousands separators: `12,345`. */
export const fmtInt = (n: number): string => intFormat.format(n);

export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;

/** A size as the server's messages write it: GiB with one decimal from 1 GiB, whole MiB below. */
export const fmtBytes = (n: number): string =>
  n >= GiB ? `${(n / GiB).toFixed(1)} GiB` : `${Math.round(n / MiB)} MiB`;
