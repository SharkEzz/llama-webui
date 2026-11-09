import { expect, test } from 'bun:test';
import { fmtInt } from './format';

test('fmtInt formats with the shared locale, not a hard-coded one (#40)', () => {
  expect(fmtInt(40192)).toBe('40,192');
  expect(fmtInt(7)).toBe('7');
});
