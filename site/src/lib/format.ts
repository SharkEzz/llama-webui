/** Number formatting for the site, same locale as the app (app/src/lib/format.ts): never a hard-coded locale. */
export const LOCALE = 'en-US';

export const formatInt = (n: number): string => Math.round(n).toLocaleString(LOCALE);

/** Fixed number of decimals: "68.4". */
export const dec = (n: number, digits = 1): string =>
  n.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "41%" (integers) or "9.9%" (below 10). */
export const formatPct = (pct: number): string => `${pct < 10 && pct > 0 ? dec(pct) : Math.round(pct)}%`;

/** "7.1 GiB" */
export const formatGiB = (gib: number, digits = 1): string => `${dec(gib, digits)} GiB`;
