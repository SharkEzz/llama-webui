import { expect, test } from 'vitest';
import { fmtBytes, fmtInt, GiB, MiB } from './format.ts';

test('fmtInt formats with the shared locale, not a hard-coded one (#40)', () => {
  expect(fmtInt(40192)).toBe('40,192');
  expect(fmtInt(7)).toBe('7');
});

test('fmtBytes writes whole MiB below 1 GiB, GiB with one decimal from there', () => {
  expect(fmtBytes(0)).toBe('0 MiB');
  expect(fmtBytes(512 * MiB)).toBe('512 MiB');
  expect(fmtBytes(GiB - 1)).toBe('1024 MiB');
  expect(fmtBytes(GiB)).toBe('1.0 GiB');
  expect(fmtBytes(12.34 * GiB)).toBe('12.3 GiB');
});
