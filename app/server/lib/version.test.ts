import { expect, test } from 'vitest';
import { APP_VERSION } from './version';

test('APP_VERSION: dev when running from source', () => {
  expect(APP_VERSION).toBe('dev');
});
