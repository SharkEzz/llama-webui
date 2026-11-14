import { expect, test } from 'vitest';
import { fmtInt } from './format.ts';

test('fmtInt formats with the shared locale, not a hard-coded one (#40)', () => {
  expect(fmtInt(40192)).toBe('40,192');
  expect(fmtInt(7)).toBe('7');
});
