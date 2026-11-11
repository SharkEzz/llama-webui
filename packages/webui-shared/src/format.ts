/** Locale of every number and date shown to the user, by the UI (`web/src/lib/format.ts`) and the server's messages. */
export const LOCALE = 'en-US';

const intFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

/** An integer with thousands separators: `12,345`. */
export const fmtInt = (n: number): string => intFormat.format(n);
