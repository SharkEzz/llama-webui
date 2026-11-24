import { expect, test } from 'vitest';
import { exportName } from './export';

test('an export is named after the moment it was taken, without a colon', () => {
  expect(exportName(new Date(2026, 10, 24, 2, 7, 3))).toBe('llama-webui-debug-2026-11-24T02-07-03.json');
});
