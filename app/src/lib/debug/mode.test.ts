import { expect, test } from 'vitest';
import { parseDebugMode } from './mode';

test('the debug mode is on only when the browser stored it so', () => {
  expect(parseDebugMode('on')).toBe(true);
  for (const raw of [null, '', 'off', 'true', 'ON']) expect(parseDebugMode(raw), String(raw)).toBe(false);
});
